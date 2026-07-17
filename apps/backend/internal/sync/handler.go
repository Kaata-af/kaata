// Package sync — HTTP handlers for the per-vault event sync pipeline.
package sync

import (
	"compress/gzip"
	"crypto/ed25519"
	"encoding/base64"
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
	VaultID string `json:"vault_id"`
	// DeviceID is the TRANSPORT device doing the push. Events authored on
	// other devices (relays, sync v2 §4 scenario 4) are legitimate: each
	// event's author is its hlc.device_id, which is what gets stored and
	// what author_seq slots key on.
	DeviceID string      `json:"device_id"`
	Events   []PushEvent `json:"events"`
}

// PushEvent is the wire format for a single event on push.
type PushEvent struct {
	EventID        string  `json:"event_id"`
	HLC            PushHLC `json:"hlc"`
	EventType      string  `json:"event_type"`
	SchemaVersion  int     `json:"schema_version"`
	TargetID       *string `json:"target_id,omitempty"`
	RelationshipID *string `json:"relationship_id,omitempty"`
	ActorAccountID *string `json:"actor_account_id,omitempty"`
	// AuthorSeq is the per-device monotonic counter assigned at append
	// time on the authoring device (sync v2 §5), keyed by hlc.device_id —
	// the author — not by the batch-level pushing device. OPTIONAL: pre-M1
	// clients omit it and their events persist with NULL author_seq. When
	// present it must be >= 1; a fresh event_id claiming an already-taken
	// (vault, author device, seq) slot is rejected with reason
	// "seq_conflict", while a duplicate event_id re-announcing a seq for
	// its stored row stays a plain duplicate (and back-fills the seq when
	// the stored row has none and the slot is free).
	AuthorSeq *int64 `json:"author_seq,omitempty"`
	// M2 (docs/m2-membership-chain.md §2): OPTIONAL author signature.
	// event_sig_b64 is the std-base64 64-byte Ed25519 signature over the
	// canonical envelope+payload (mobile lib/event-sig.ts; Go mirror in
	// membership.go canonicalSignableEvent); signer_device_pubkey is the
	// std-base64 32-byte pubkey of the signing device. Supplied together
	// or not at all. Pre-M2 clients omit both — their membership events
	// keep the legacy JWT ACL. On anchored vaults, signed membership
	// events are verified against the chain rules and rejected per-event
	// with reason "membership_unverified" on failure.
	EventSigB64           *string         `json:"event_sig_b64,omitempty"`
	SignerDevicePubkeyB64 *string         `json:"signer_device_pubkey,omitempty"`
	Payload               json.RawMessage `json:"payload"`
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
			case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound),
				errors.Is(err, ErrVaultArchived):
				writeMembershipDenied(w, err)
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
		if ev.AuthorSeq != nil && *ev.AuthorSeq < 1 {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].author_seq must be >= 1 when present")
			return
		}
		// M2: signature material is all-or-nothing and syntactically valid
		// base64 of the right lengths. Authorization (anchor / bound
		// device / witness) is the service's job; this is wire hygiene.
		hasSig := ev.EventSigB64 != nil && *ev.EventSigB64 != ""
		hasSignerPub := ev.SignerDevicePubkeyB64 != nil && *ev.SignerDevicePubkeyB64 != ""
		if hasSig != hasSignerPub {
			httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"]: event_sig_b64 and signer_device_pubkey must be supplied together")
			return
		}
		if hasSig {
			raw, err := base64.StdEncoding.DecodeString(*ev.EventSigB64)
			if err != nil || len(raw) != ed25519.SignatureSize {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].event_sig_b64 must be standard base64 of a 64-byte signature")
				return
			}
			raw, err = base64.StdEncoding.DecodeString(*ev.SignerDevicePubkeyB64)
			if err != nil || len(raw) != ed25519.PublicKeySize {
				httpx.Error(w, http.StatusBadRequest, "events["+strconv.Itoa(i)+"].signer_device_pubkey must be standard base64 of a 32-byte Ed25519 pubkey")
				return
			}
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
			// NOTE: target_id on account_bound carries the local-self USER id
			// (payload.from_user_id), NOT the account id — it is device-local
			// metadata the mobile projection uses to bind its self-user row.
			// The binding is authorized solely by payload.account_id (checked
			// above) and resolved server-side from the events.account_id column
			// (see account_binding.go scanBindings), never from target_id.
			// target_id is still validated as a syntactic UUID below.
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
		case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound),
			errors.Is(err, ErrVaultArchived):
			writeMembershipDenied(w, err)
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

// writeMembershipDenied writes the 403 for a membership-denied push/pull with
// a stable error_code the client can branch on: "not_member" (the vault
// EXISTS but the caller holds no active membership — the only signal a
// removed member's device ever gets of its own removal, since the revocation
// commits in the same tx as the removal event and blocks the pull that would
// have delivered it) vs "vault_unknown" (no such vault — genuinely
// unregistered/purged) vs "vault_archived" (still a member; vault archived
// and caller is not the owner — client archives locally, never self-revokes).
// Codes follow the vaults handlers' mapServiceError naming ("not_member").
// The existence signal disclosed to authenticated non-members is acceptable:
// vault ids are UUIDv4, not enumerable.
func writeMembershipDenied(w http.ResponseWriter, err error) {
	code := "not_member"
	msg := "not a member of this vault"
	switch {
	case errors.Is(err, ErrVaultNotFound):
		code = "vault_unknown"
	case errors.Is(err, ErrVaultArchived):
		// DISTINCT from not_member: the caller IS still an active member —
		// the vault is archived and they are not its owner. The client must
		// archive the kaata locally, NOT self-revoke its membership (that
		// reaction is irreversible client-side and turned every owner-side
		// archive into a silent delete on members' phones).
		code = "vault_archived"
		msg = "vault is archived"
	}
	httpx.ErrorCode(w, http.StatusForbidden, code, msg)
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
		case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound),
			errors.Is(err, ErrVaultArchived):
			writeMembershipDenied(w, err)
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

// ==========================================================================
// VECTOR
// ==========================================================================

// Vector — GET /v1/sync/vector?vault_id=<uuid> (PROTECTED).
//
// Returns the server replica's per-device author_seq summary for the vault
// (sync v2 §5): for each authoring device, {max_seq, count, min_seq} over
// non-redacted events that carry an author_seq, plus the vault's server_seq
// high-water mark. Clients infer "provably complete from 1" as
// min_seq == 1 && count == max_seq.
//
// Auth + membership gating mirror Pull: 401 without a session, 403 for
// non-members and unknown vaults alike (no existence oracle).
func (h *Handler) Vector(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	vaultID := r.URL.Query().Get("vault_id")
	if vaultID == "" {
		httpx.Error(w, http.StatusBadRequest, "vault_id is required")
		return
	}
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}

	res, err := h.svc.DeviceVectors(r.Context(), claims.AccountID, vaultID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound),
			errors.Is(err, ErrVaultArchived):
			httpx.Error(w, http.StatusForbidden, "not a member of this vault")
			return
		default:
			log.Printf("sync.vector failed for account=%s vault=%s: %v",
				claims.AccountID, vaultID, err)
			httpx.Error(w, http.StatusInternalServerError, "sync vector failed")
			return
		}
	}

	httpx.JSON(w, http.StatusOK, res)
}
