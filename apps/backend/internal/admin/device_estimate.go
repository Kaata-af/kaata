package admin

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// DeviceEstimate groups self-reported platform identifiers for analytics only.
// Each installation without an identifier remains a separate unknown device;
// neither account ownership nor installation history is inferred from a match.
type DeviceEstimate struct {
	EstimatedDevices     int64 `json:"estimated_devices"`
	IdentifiedDevices    int64 `json:"identified_devices"`
	IdentifiedInstalls   int64 `json:"identified_installs"`
	UnidentifiedInstalls int64 `json:"unidentified_installs"`
	TotalInstalls        int64 `json:"total_installs"`
}

func (e *DeviceEstimate) setTotalInstalls(total int64) {
	e.TotalInstalls = total
	e.UnidentifiedInstalls = total - e.IdentifiedInstalls
	e.EstimatedDevices = e.IdentifiedDevices + e.UnidentifiedInstalls
}

// GetUsers calls this within its existing read-only snapshot. Stats computes
// the same counts in its funnel query so coverage and total installs agree
// even when a new check-in arrives while the report is being assembled.
func (s *Service) getDeviceEstimate(ctx context.Context, tx pgx.Tx) (DeviceEstimate, error) {
	var estimate DeviceEstimate
	var total int64
	err := tx.QueryRow(ctx, `
		WITH `+reportExclusionCTEs+`
		SELECT COUNT(*),
		       COUNT(*) FILTER (WHERE device_id_hash IS NOT NULL),
		       COUNT(DISTINCT (device_id_kind, device_id_hash)) FILTER (WHERE device_id_hash IS NOT NULL)
		FROM installs
		WHERE install_id NOT IN (SELECT install_id FROM report_excluded_installs)
	`, s.operatorAccountIDs).Scan(&total, &estimate.IdentifiedInstalls, &estimate.IdentifiedDevices)
	if err != nil {
		return estimate, err
	}
	estimate.setTotalInstalls(total)
	return estimate, nil
}
