package admin

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/visit"
)

type appleAcquisitionDay struct {
	Date           string            `json:"date"`
	ProcessingDate string            `json:"processing_date"`
	Downloads      map[string]*int64 `json:"downloads"`
}

// ImportAppleAcquisition accepts daily aggregates from the operator's local
// App Store Connect importer. No Apple credentials or report files are stored.
func (h *Handler) ImportAppleAcquisition(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Days []appleAcquisitionDay `json:"days"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil || decoder.Decode(new(any)) != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON import")
		return
	}
	if len(req.Days) == 0 || len(req.Days) > 366 {
		httpx.Error(w, http.StatusBadRequest, "include between 1 and 366 report dates")
		return
	}
	seen := make(map[string]bool, len(req.Days))
	sources := visit.AcquisitionSources()
	today := h.svc.now().UTC().Format(time.DateOnly)
	for _, day := range req.Days {
		if _, err := time.Parse(time.DateOnly, day.Date); err != nil || day.Date < "2008-07-10" || day.Date > today || seen[day.Date] {
			httpx.Error(w, http.StatusBadRequest, "invalid or duplicate report date")
			return
		}
		if _, err := time.Parse(time.DateOnly, day.ProcessingDate); err != nil || day.ProcessingDate < day.Date || day.ProcessingDate > today {
			httpx.Error(w, http.StatusBadRequest, "invalid processing date")
			return
		}
		seen[day.Date] = true
		if day.Downloads == nil {
			httpx.Error(w, http.StatusBadRequest, "downloads must be an object")
			return
		}
		for source, count := range day.Downloads {
			if !slices.Contains(sources, source) || count == nil || *count < 0 || *count > math.MaxInt32 {
				httpx.Error(w, http.StatusBadRequest, "invalid source or download count")
				return
			}
		}
	}
	if err := h.svc.replaceAppleAcquisition(r.Context(), req.Days); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Apple acquisition import failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) replaceAppleAcquisition(ctx context.Context, days []appleAcquisitionDay) error {
	var dates, processingDates []string
	for _, day := range days {
		dates = append(dates, day.Date)
		processingDates = append(processingDates, day.ProcessingDate)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Lock dates in a consistent order. PostgreSQL compares a conflicting
	// row after obtaining its lock, so a stale import cannot replace a newer
	// revision even when the newer report contained no source values.
	rows, err := tx.Query(ctx, `INSERT INTO apple_acquisition_import_days(report_date,processing_date)
		SELECT d::date,p::date FROM unnest($1::text[],$2::text[]) AS data(d,p) ORDER BY d
		ON CONFLICT (report_date) DO UPDATE SET processing_date=EXCLUDED.processing_date
		WHERE EXCLUDED.processing_date >= apple_acquisition_import_days.processing_date
		RETURNING report_date::text`, dates, processingDates)
	if err != nil {
		return err
	}
	var acceptedDates []string
	accepted := make(map[string]bool, len(dates))
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			rows.Close()
			return err
		}
		acceptedDates = append(acceptedDates, date)
		accepted[date] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(acceptedDates) == 0 {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM apple_acquisition_daily
		WHERE report_date IN (SELECT d::date FROM unnest($1::text[]) d)`, acceptedDates); err != nil {
		return err
	}
	var reportedDates, sources []string
	var counts []int32
	for _, day := range days {
		if accepted[day.Date] {
			for source, count := range day.Downloads {
				reportedDates = append(reportedDates, day.Date)
				sources = append(sources, source)
				counts = append(counts, int32(*count))
			}
		}
	}
	if len(counts) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO apple_acquisition_daily(report_date,source,first_downloads)
			SELECT d::date, source, downloads FROM unnest($1::text[],$2::text[],$3::integer[]) AS data(d,source,downloads)`,
			reportedDates, sources, counts); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
