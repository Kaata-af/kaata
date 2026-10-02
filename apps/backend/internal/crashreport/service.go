package crashreport

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUnknownInstall = errors.New("unknown install_id")
	ErrInstallRetired = errors.New("installation was retired after account deletion")
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
	if len(req.Reports) == 0 {
		return nil
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Account deletion marks the installation before removing diagnostics.
	// FOR SHARE conflicts with that marker UPDATE (FOR KEY SHARE would not),
	// so a queued flush either commits before deletion and is erased, or
	// observes the marker and stores nothing. Hold this lock for the batch.
	var retired bool
	err = tx.QueryRow(ctx, `SELECT account_deleted_at IS NOT NULL FROM installs
		WHERE install_id = $1::uuid FOR SHARE`, req.InstallID).Scan(&retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnknownInstall
	}
	if err != nil {
		return err
	}
	if retired {
		return ErrInstallRetired
	}

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
		if _, err := tx.Exec(ctx, `
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
	return tx.Commit(ctx)
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
