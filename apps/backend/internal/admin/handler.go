package admin

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

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
// the window is fixed at the last 12 Saturday–Friday weeks. Mounted behind
// httpx.AdminKeyMiddleware.
func (h *Handler) Growth(w http.ResponseWriter, r *http.Request) {
	g, err := h.svc.GetGrowth(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "growth query failed")
		return
	}
	httpx.JSON(w, http.StatusOK, g)
}

// DayComparison — GET /v1/admin/day-comparison. Uses completed Kabul hours.
func (h *Handler) DayComparison(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	var comparison DayComparison
	var err error
	if query.Has("days") || query.Has("preset") {
		if query.Has("day") || query.Has("compare_day") || (query.Has("days") && query.Has("preset")) || len(query["days"]) > 1 || len(query["preset"]) > 1 || (query.Has("preset") && query.Get("preset") == "") {
			httpx.Error(w, http.StatusBadRequest, "choose either days, preset, or a legacy date pair")
			return
		}
		var days []string
		if query.Has("days") {
			days = strings.Split(query.Get("days"), ",")
		}
		comparison, err = h.svc.GetDayComparisons(r.Context(), days, query.Get("preset"))
	} else {
		comparison, err = h.svc.GetDayComparison(r.Context(), query.Get("day"), query.Get("compare_day"))
	}
	if err != nil {
		if errors.Is(err, ErrDayComparisonDate) {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "day comparison query failed")
		return
	}
	httpx.JSON(w, http.StatusOK, comparison)
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
