// Package sync — HTTP handlers for the per-vault event sync pipeline.
package sync

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

// Body limits.
//
// Compressed wire ceiling: 1 MiB. Decompressed ceiling: 16 MiB. Per-event
// payload: 64 KiB. Per-batch event count: 500.
const (
	MaxCompressedBodyBytes   = 1 << 20  // 1 MiB
	MaxDecompressedBodyBytes = 16 << 20 // 16 MiB
	MaxEventsPerBatch        = 500
	MaxPayloadBytes          = 64 << 10 // 64 KiB
)

// Defaults / clamps for GET /v1/sync/pull.
const (
	pullDefaultLimit = 200
	pullMaxLimit     = 1000
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// ==========================================================================
// PUSH wire types
// ==========================================================================

type pushRequest struct {
	VaultID  string      `json:"vault_id"`
	DeviceID string      `json:"device_id"`
	Events   []PushEvent `json:"events"`
}

// PushEvent is the wire format for a single event on push.
type PushEvent struct {
	EventID        string          `json:"event_id"`
	HLC            PushHLC         `json:"hlc"`
	EventType      string          `json:"event_type"`
	SchemaVersion  int             `json:"schema_version"`
	TargetID       *string         `json:"target_id,omitempty"`
	RelationshipID *string         `json:"relationship_id,omitempty"`
	ActorAccountID *string         `json:"actor_account_id,omitempty"`
	Payload        json.RawMessage `json:"payload"`
}

type PushHLC struct {
	PhysicalMS int64  `json:"physical_ms"`
	Logical    int64  `json:"logical"`
	DeviceID   string `json:"device_id"`
}

type PushResponse struct {
	Accepted           []AcceptedEvent `json:"accepted"`
	Duplicates         []string        `json:"duplicates"`
	Rejected           []RejectedEvent `json:"rejected"`
	VaultServerSeqHigh int64           `json:"vault_server_seq_high"`
}

type AcceptedEvent struct {
	EventID   string `json:"event_id"`
	ServerSeq int64  `json:"server_seq"`
}

type RejectedEvent struct {
	EventID      string `json:"event_id"`
	Reason       string `json:"reason"`
	CurrentRole  string `json:"current_role,omitempty"`
	RequiredRole string `json:"required_role,omitempty"`
}

// Push — POST /v1/sync/push (PROTECTED).
func (h *Handler) Push(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxCompressedBodyBytes)

	body, err := readMaybeGzipped(r)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		httpx.Error(w, http.StatusBadRequest, "could not read request body: "+err.Error())
		return
	}

	var req pushRequest
	if err := json.Unmarshal(body, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}

	if _, err := uuid.Parse(req.VaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}
	if _, err := uuid.Parse(req.DeviceID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "device_id must be a uuid")
		return
	}
	if len(req.Events) == 0 {
		// Still run membership through the service so a non-member
		// probing for vault existence gets a 403, not a 200 — closes
		// the existence-oracle gap on the empty-batch shortcut.
		res, err := h.svc.PushEvents(r.Context(), PushInput{
			AccountID: claims.AccountID,
			VaultID:   req.VaultID,
			DeviceID:  req.DeviceID,
			Events:    nil,
		})
		if err != nil {
			switch {
			case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound):
				httpx.Error(w, http.StatusForbidden, "not a member of this vault")
				return
			default:
				log.Printf("sync.push (empty) failed for account=%s vault=%s: %v",
					claims.AccountID, req.VaultID, err)
				httpx.Error(w, http.StatusInternalServerError, "sync push failed")
				return
			}
		}
		httpx.JSON(w, http.StatusOK, res)
		return
	}
	if len(req.Events) > MaxEventsPerBatch {
		httpx.Error(w, http.StatusBadRequest, "batch exceeds 500 events; chunk on the client")
		return
	}
	for i, ev := range req.Events {
		if _, err := uuid.Parse(ev.EventID); err != nil {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].event_id must be a uuid")
			return
		}
		if ev.EventType == "" {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].event_type is required")
			return
		}
		if ev.SchemaVersion <= 0 {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].schema_version must be >= 1")
			return
		}
		if _, err := uuid.Parse(ev.HLC.DeviceID); err != nil {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].hlc.device_id must be a uuid")
			return
		}
		// Audit-log integrity: the actor_account_id stamped on the wire
		// MUST equal the JWT claim. Otherwise a malicious client could
		// attribute writes (within their own vault membership) to a
		// different account, poisoning the audit trail and any future
		// "lawful at HLC" ACL check that keys off events.account_id.
		if ev.ActorAccountID != nil && *ev.ActorAccountID != "" && *ev.ActorAccountID != claims.AccountID {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].actor_account_id does not match session account")
			return
		}
		// Phase 4.1 SEC C1: account_bound is short-circuited by
		// CheckEventPermission with allowed=true; the only ACL gate
		// available is here. Decode the payload and assert that the
		// bound account is the JWT's account. Without this check, a
		// signed-in editor could push:
		//   account_bound { account_id: <owner_acct>, retroactive_through_event_id: ... }
		// with a synthetic-early HLC, becoming the earliest-by-HLC
		// binding. The BindingResolver would then attribute every
		// NULL-actor event in the vault to the owner, poisoning the
		// audit trail AND laundering events under owner-grade ACL.
		if ev.EventType == "account_bound" {
			var p struct {
				AccountID string `json:"account_id"`
			}
			if err := json.Unmarshal(ev.Payload, &p); err != nil {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].payload is not valid json")
				return
			}
			if p.AccountID == "" {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].payload.account_id is required for account_bound")
				return
			}
			if p.AccountID != claims.AccountID {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].payload.account_id does not match session account")
				return
			}
			// target_id (when present) is also the bound account on
			// account_bound events; gate it too for defense in depth.
			if ev.TargetID != nil && *ev.TargetID != "" && *ev.TargetID != claims.AccountID {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].target_id does not match session account on account_bound")
				return
			}
		}
		// Optional UUID syntactic checks for envelope refs.
		if ev.TargetID != nil && *ev.TargetID != "" {
			if _, err := uuid.Parse(*ev.TargetID); err != nil {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].target_id must be a uuid")
				return
			}
		}
		if ev.RelationshipID != nil && *ev.RelationshipID != "" {
			if _, err := uuid.Parse(*ev.RelationshipID); err != nil {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].relationship_id must be a uuid")
				return
			}
		}
		if len(ev.Payload) > MaxPayloadBytes {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].payload exceeds 64 KiB")
			return
		}
	}

	res, err := h.svc.PushEvents(r.Context(), PushInput{
		AccountID: claims.AccountID,
		VaultID:   req.VaultID,
		DeviceID:  req.DeviceID,
		Events:    req.Events,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound):
			httpx.Error(w, http.StatusForbidden, "not a member of this vault")
			return
		default:
			log.Printf("sync.push failed for account=%s vault=%s: %v",
				claims.AccountID, req.VaultID, err)
			httpx.Error(w, http.StatusInternalServerError, "sync push failed")
			return
		}
	}
	httpx.JSON(w, http.StatusOK, res)
}

// readMaybeGzipped reads request body, transparently gunzipping if header says
// so. Bounded at MaxDecompressedBodyBytes via io.LimitReader.
func readMaybeGzipped(r *http.Request) ([]byte, error) {
	if r.Header.Get("Content-Encoding") != "gzip" {
		return io.ReadAll(io.LimitReader(r.Body, MaxDecompressedBodyBytes+1))
	}
	gz, err := gzip.NewReader(r.Body)
	if err != nil {
		return nil, err
	}
	defer func() { _ = gz.Close() }()
	buf, err := io.ReadAll(io.LimitReader(gz, MaxDecompressedBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(buf) > MaxDecompressedBodyBytes {
		return nil, errors.New("decompressed body exceeds 16 MiB cap")
	}
	return buf, nil
}

// ==========================================================================
// PULL
// ==========================================================================

// Pull — GET /v1/sync/pull?vault_id=<uuid>&after_server_seq=<n>&limit=<n>
// (PROTECTED).
func (h *Handler) Pull(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	q := r.URL.Query()

	vaultID := q.Get("vault_id")
	if vaultID == "" {
		httpx.Error(w, http.StatusBadRequest, "vault_id is required")
		return
	}
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}

	var afterServerSeq int64
	if raw := q.Get("after_server_seq"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "after_server_seq must be an integer")
			return
		}
		if n < 0 {
			httpx.Error(w, http.StatusBadRequest, "after_server_seq must be >= 0")
			return
		}
		afterServerSeq = n
	}

	limit := pullDefaultLimit
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "limit must be an integer")
			return
		}
		if n <= 0 {
			httpx.Error(w, http.StatusBadRequest, "limit must be > 0")
			return
		}
		if n > pullMaxLimit {
			n = pullMaxLimit
		}
		limit = n
	}

	res, err := h.svc.PullEvents(r.Context(), PullInput{
		AccountID:      claims.AccountID,
		VaultID:        vaultID,
		AfterServerSeq: afterServerSeq,
		Limit:          limit,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound):
			httpx.Error(w, http.StatusForbidden, "not a member of this vault")
			return
		default:
			log.Printf("sync.pull failed for account=%s vault=%s: %v",
				claims.AccountID, vaultID, err)
			httpx.Error(w, http.StatusInternalServerError, "sync pull failed")
			return
		}
	}

	httpx.JSON(w, http.StatusOK, res)
}

// ==========================================================================
// SNAPSHOT
// ==========================================================================

// Snapshot — GET /v1/sync/snapshot?vault_id=<uuid> (PROTECTED).
func (h *Handler) Snapshot(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	vaultIDRaw := r.URL.Query().Get("vault_id")
	if vaultIDRaw == "" {
		httpx.Error(w, http.StatusBadRequest, "vault_id is required")
		return
	}
	vaultID, err := uuid.Parse(vaultIDRaw)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}

	// ACL first — never disclose vault existence to a non-member.
	isMember, err := h.svc.IsMember(r.Context(), claims.AccountID, vaultID.String())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "membership check failed")
		return
	}
	if !isMember {
		httpx.Error(w, http.StatusForbidden, "not a member of this vault")
		return
	}

	resp, err := h.svc.LatestSnapshot(r.Context(), vaultID.String())
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "no snapshot available")
		return
	}
	if err != nil {
		log.Printf("sync/snapshot: read failed for vault=%s: %v", vaultID, err)
		httpx.Error(w, http.StatusServiceUnavailable, "snapshot fetch failed")
		return
	}

	httpx.JSON(w, http.StatusOK, resp)
}
