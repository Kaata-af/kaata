package crashreport

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Service ingests batches of client-reported crash/diagnostic items.
// Append-only: every item becomes one crash_reports row. No dedup, no
// upsert — the stream IS the data.
type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// Item is one reported diagnostic event. See migration 012 for the `kind`
// taxonomy. Numeric fields are pointers so "absent" is distinguishable
// from "zero" for the exit/memsample rows.
type Item struct {
	Kind            string `json:"kind"`
	Stage           string `json:"stage"`
	Name            string `json:"name"`
	Message         string `json:"message"`
	RssKb           *int64 `json:"rss_kb,omitempty"`
	AuxKb           *int64 `json:"aux_kb,omitempty"`
	CreatedAtUnixMS int64  `json:"created_at_unix_ms"`
}

type Request struct {
	InstallID  string `json:"install_id"`
	AppVersion string `json:"app_version"`
	Platform   string `json:"platform"`
	Reports    []Item `json:"reports"`
}

// knownKinds mirrors the CHECK constraint in migration 012. We validate
// here too so a bad client can't push a row that fails the DB constraint
// mid-batch and aborts the whole flush.
var knownKinds = map[string]bool{
	"boot": true, "mesh": true, "sync": true, "exit": true,
	"memsample": true, "js": true, "native": true,
}

func (s *Service) Handle(ctx context.Context, req Request, clientIP string) error {
	for _, it := range req.Reports {
		kind := it.Kind
		if !knownKinds[kind] {
			kind = "js" // clamp unknown kinds rather than reject the batch
		}
		msg := it.Message
		if len(msg) > 4000 {
			msg = msg[:4000]
		}
		var createdAt *time.Time
		if it.CreatedAtUnixMS > 0 {
			t := time.UnixMilli(it.CreatedAtUnixMS)
			createdAt = &t
		}
		appVersion := req.AppVersion
		if appVersion == "" {
			appVersion = "unknown"
		}
		platform := req.Platform
		if platform == "" {
			platform = "unknown"
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO crash_reports
			  (install_id, kind, stage, name, message, app_version, platform,
			   rss_kb, aux_kb, client_created_at, ip)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		`,
			req.InstallID,
			kind,
			nullIfEmpty(it.Stage),
			nullIfEmpty(it.Name),
			msg,
			appVersion,
			platform,
			it.RssKb,
			it.AuxKb,
			createdAt,
			clientIP,
		); err != nil {
			return err
		}
	}
	return nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
