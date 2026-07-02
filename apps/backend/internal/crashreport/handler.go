package crashreport

import (
	"encoding/json"
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// Report ingests a batch of client diagnostic items. Public + anonymous
// (mounted in the same OptionalMiddleware group as /v1/check-in) so a
// local-only install with no account can still report why it died.
func (h *Handler) Report(w http.ResponseWriter, r *http.Request) {
	// Anonymous ingest: cap the body so one request can't buffer unbounded
	// JSON into memory. 256 KiB is far above any legitimate flush (100 items
	// of a few hundred bytes each); a batch that trips it 400s at decode.
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "install_id must be a uuid")
		return
	}
	if len(req.Reports) == 0 {
		// Nothing to do — a no-op flush is not an error.
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "accepted": 0})
		return
	}
	if len(req.Reports) > 100 {
		httpx.Error(w, http.StatusBadRequest, "reports must be 1..100 items")
		return
	}
	// Server-side clamp: migration 012's CHECK constraint only covers
	// message, so stage/name would otherwise land verbatim in unbounded TEXT
	// columns. Message stays within the service's 4000-byte truncation so
	// its byte slice never fires (which could split a UTF-8 rune).
	req.AppVersion = truncateUTF8(req.AppVersion, 64)
	req.Platform = truncateUTF8(req.Platform, 64)
	for i := range req.Reports {
		it := &req.Reports[i]
		it.Stage = truncateUTF8(it.Stage, 200)
		it.Name = truncateUTF8(it.Name, 500)
		it.Message = truncateUTF8(it.Message, 4000)
	}
	if err := h.svc.Handle(r.Context(), req, httpx.ClientIP(r)); err != nil {
		// install_id has an FK to installs; a flush that races ahead of the
		// install's first check-in (mobile flushes before the check-in POST on
		// the same launch) is a client-ordering problem, not a server fault.
		// Surface it as 400 — the client keeps the rows queued and retries
		// after the check-in has minted the installs row.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			httpx.Error(w, http.StatusBadRequest, "unknown install_id")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "crash report failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "accepted": len(req.Reports)})
}

// truncateUTF8 caps s at max bytes, backing up to a rune boundary so the
// result stays valid UTF-8 — Postgres rejects invalid byte sequences, which
// would abort the whole insert.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}
