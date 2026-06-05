package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxSnapshotBytes guards against accidentally enormous payloads. A
// power user with ~50 entries serializes to ~20KB; 5MB is roughly 4
// orders of magnitude over that, plenty of headroom for the foreseeable
// future and a clear bug-or-attack signal if exceeded.
const MaxSnapshotBytes = 5 * 1024 * 1024

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// UploadRequest is what the mobile client posts. snapshot is the full
// SQLite-derived JSON. We don't introspect it server-side — the schema
// is owned by mobile, and the version field inside lets us evolve
// without server-side coordination.
type UploadRequest struct {
	Snapshot        json.RawMessage `json:"snapshot"`
	SnapshotVersion int             `json:"snapshot_version"`
	AppVersion      string          `json:"app_version"`
}

type UploadResponse struct {
	UpdatedAt time.Time `json:"updated_at"`
	ByteSize  int       `json:"byte_size"`
}

type LatestResponse struct {
	// nil when the install has never uploaded a backup.
	Snapshot        json.RawMessage `json:"snapshot,omitempty"`
	SnapshotVersion int             `json:"snapshot_version,omitempty"`
	AppVersion      string          `json:"app_version,omitempty"`
	ByteSize        int             `json:"byte_size,omitempty"`
	UpdatedAt       *time.Time      `json:"updated_at,omitempty"`
}

// Upload stores or replaces this install's backup. Per the migration
// the table has install_id as PK, so each install only ever has one row
// — the most recent snapshot.
func (s *Service) Upload(
	ctx context.Context,
	installID, providerSub string,
	req UploadRequest,
) (UploadResponse, error) {
	if len(req.Snapshot) == 0 {
		return UploadResponse{}, errors.New("snapshot is required")
	}
	if len(req.Snapshot) > MaxSnapshotBytes {
		return UploadResponse{}, fmt.Errorf(
			"snapshot too large: %d bytes (max %d)",
			len(req.Snapshot), MaxSnapshotBytes,
		)
	}
	version := req.SnapshotVersion
	if version <= 0 {
		version = 1
	}
	appVersion := req.AppVersion
	if appVersion == "" {
		appVersion = "unknown"
	}
	byteSize := len(req.Snapshot)

	var updatedAt time.Time
	err := s.pool.QueryRow(ctx, `
		INSERT INTO backups (
			install_id, provider_sub, snapshot,
			snapshot_version, app_version, byte_size,
			created_at, updated_at
		)
		VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW(), NOW())
		ON CONFLICT (install_id) DO UPDATE
		SET snapshot         = EXCLUDED.snapshot,
		    snapshot_version = EXCLUDED.snapshot_version,
		    app_version      = EXCLUDED.app_version,
		    provider_sub     = EXCLUDED.provider_sub,
		    byte_size        = EXCLUDED.byte_size,
		    updated_at       = NOW()
		RETURNING updated_at
	`, installID, providerSub, string(req.Snapshot), version, appVersion, byteSize).Scan(&updatedAt)
	if err != nil {
		return UploadResponse{}, fmt.Errorf("upsert backup: %w", err)
	}
	return UploadResponse{UpdatedAt: updatedAt, ByteSize: byteSize}, nil
}

// Latest returns this install's most recent backup, or an empty
// response if no backup has been uploaded yet. Phase 1 only looks at
// the current install — the eventual cross-device restore will query
// by provider_sub via the idx_backups_provider_sub_updated index.
func (s *Service) Latest(ctx context.Context, installID string) (LatestResponse, error) {
	var snapshot []byte
	var version int
	var appVersion string
	var byteSize int
	var updatedAt time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT snapshot, snapshot_version, app_version, byte_size, updated_at
		FROM backups
		WHERE install_id = $1
	`, installID).Scan(&snapshot, &version, &appVersion, &byteSize, &updatedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return LatestResponse{}, nil
	case err != nil:
		return LatestResponse{}, fmt.Errorf("query backup: %w", err)
	}
	return LatestResponse{
		Snapshot:        snapshot,
		SnapshotVersion: version,
		AppVersion:      appVersion,
		ByteSize:        byteSize,
		UpdatedAt:       &updatedAt,
	}, nil
}
