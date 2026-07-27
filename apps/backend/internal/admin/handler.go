package admin

import (
	"net/http"
	"strconv"

	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// Stats — GET /v1/admin/stats. Mounted behind httpx.AdminKeyMiddleware.
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	// ?bucket = hour|day|week|month, ?points = how many buckets back. Both
	// validated/clamped in GetStats. Defaults: day × 30.
	bucket := r.URL.Query().Get("bucket")
	if bucket == "" {
		bucket = "day"
	}
	points := 30
	if v := r.URL.Query().Get("points"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			points = n
		}
	}
	st, err := h.svc.GetStats(r.Context(), bucket, points)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "stats query failed")
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

// Growth — GET /v1/admin/growth. Weekly cohort retention + growth accounting +
// adoption for the dashboard's Retention/Overview sections. No query params —
// the window is fixed at the last 12 ISO weeks. Mounted behind
// httpx.AdminKeyMiddleware.
func (h *Handler) Growth(w http.ResponseWriter, r *http.Request) {
	g, err := h.svc.GetGrowth(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "growth query failed")
		return
	}
	httpx.JSON(w, http.StatusOK, g)
}

// Users — GET /v1/admin/users. The operator drill-down: signed-in users, their
// kaatas + members + per-kaata tally/customer counts (not contents). Mounted
// behind httpx.AdminKeyMiddleware.
func (h *Handler) Users(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.GetUsers(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "users query failed")
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}
