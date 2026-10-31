package sync

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

const webNoteHistoryLimit = 50

type webNoteCursor struct {
	VaultID        string `json:"vault_id"`
	RelationshipID string `json:"relationship_id"`
	HLC            HLC    `json:"hlc"`
	EventID        string `json:"event_id"`
}

type WebPersonNoteRevision struct {
	EventID string  `json:"event_id"`
	Note    *string `json:"note"`
	At      int64   `json:"at"`
	// A signed actor claim is not a verified device-to-account binding. Keep
	// authors unknown until the browser history has that independent authority.
	Actor any `json:"actor"`
}

type WebPersonNoteHistory struct {
	Entries    []WebPersonNoteRevision `json:"entries"`
	NextCursor *string                 `json:"next_cursor"`
	HasMore    bool                    `json:"has_more"`
}

func parseWebNoteCursor(raw, vaultID, relationshipID string) (*webNoteCursor, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 1024 {
		return nil, errors.New("invalid note history cursor")
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	var cursor webNoteCursor
	if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.VaultID != vaultID || cursor.RelationshipID != relationshipID || cursor.HLC.PMS < 0 || cursor.HLC.PMS > maxJavaScriptSafeInteger || cursor.HLC.L < 0 || cursor.HLC.L > maxJavaScriptSafeInteger {
		return nil, errors.New("invalid note history cursor")
	}
	if _, err := uuid.Parse(cursor.HLC.DID); err != nil {
		return nil, errors.New("invalid note history cursor")
	}
	if _, err := uuid.Parse(cursor.EventID); err != nil {
		return nil, errors.New("invalid note history cursor")
	}
	return &cursor, nil
}

// Optional relationship-scoped mode on the existing private notes endpoint.
// Mobile's ascending server-sequence recovery stream is unchanged.
func (h *Handler) webPersonNotes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, 401, "authentication required")
		return
	}
	query := r.URL.Query()
	vaultID, err := uuid.Parse(query.Get("vault_id"))
	if err != nil {
		httpx.Error(w, 400, "invalid vault_id")
		return
	}
	relationshipID, err := uuid.Parse(query.Get("relationship_id"))
	if err != nil || len(query["relationship_id"]) != 1 || len(query["cursor"]) > 1 || query.Has("after_server_seq") {
		httpx.Error(w, 400, "invalid relationship history request")
		return
	}
	cursor, err := parseWebNoteCursor(query.Get("cursor"), vaultID.String(), relationshipID.String())
	if err != nil {
		httpx.Error(w, 400, "invalid note history cursor")
		return
	}
	if !h.allowCurrencyClient(w, r, vaultID.String(), claims.AccountID) {
		return
	}
	if err := h.svc.checkMembershipFresh(r.Context(), claims.AccountID, vaultID.String()); err != nil {
		if errors.Is(err, ErrNotMember) || errors.Is(err, ErrVaultNotFound) || errors.Is(err, ErrVaultArchived) {
			writeMembershipDenied(w, err)
		} else {
			httpx.Error(w, 503, "customer note history unavailable")
		}
		return
	}
	page, err := readWebPersonNoteHistory(r.Context(), h.svc.pool, vaultID.String(), relationshipID.String(), cursor)
	if err != nil {
		httpx.Error(w, 503, "customer note history unavailable")
		return
	}
	httpx.JSON(w, 200, page)
}

func readWebPersonNoteHistory(ctx context.Context, query snapshotEventQuerier, vaultID, relationshipID string, cursor *webNoteCursor) (*WebPersonNoteHistory, error) {
	args := []any{vaultID, relationshipID, webNoteHistoryLimit + 1}
	before := ""
	if cursor != nil {
		before = " AND (hlc_physical_ms,hlc_logical,hlc_device_id,event_id) < ($4,$5,$6::uuid,$7::uuid)"
		args = append(args, cursor.HLC.PMS, cursor.HLC.L, cursor.HLC.DID, cursor.EventID)
	}
	rows, err := query.Query(ctx, `SELECT `+pulledEventColumns+` FROM events
		WHERE vault_id=$1::uuid AND relationship_id=$2::uuid
		AND COALESCE(local_target_id,target_id::text)=$2::text
		AND event_type='person_note_set' AND redacted_at IS NULL`+before+`
		ORDER BY hlc_physical_ms DESC,hlc_logical DESC,hlc_device_id DESC,event_id DESC LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	events, err := scanPulledEvents(rows)
	if err != nil {
		return nil, err
	}
	page := &WebPersonNoteHistory{Entries: []WebPersonNoteRevision{}, HasMore: len(events) > webNoteHistoryLimit}
	if page.HasMore {
		events = events[:webNoteHistoryLimit]
	}
	for _, event := range events {
		note, err := decodePersonNote(event.Payload)
		if err != nil {
			continue
		}
		page.Entries = append(page.Entries, WebPersonNoteRevision{EventID: event.EventID, Note: note, At: event.HLC.PMS})
	}
	if page.HasMore {
		last := events[len(events)-1]
		raw, err := json.Marshal(webNoteCursor{VaultID: vaultID, RelationshipID: relationshipID, HLC: last.HLC, EventID: last.EventID})
		if err != nil {
			return nil, err
		}
		encoded := base64.RawURLEncoding.EncodeToString(raw)
		page.NextCursor = &encoded
	}
	return page, nil
}
