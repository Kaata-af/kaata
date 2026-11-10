package admin

// AudienceEstimate combines distinct accounts with a conservative estimate
// of people who use Kaata while signed out. A device match only affects the
// estimate. It never changes account linkage or installation history.
type AudienceEstimate struct {
	EstimatedUsers                int64 `json:"estimated_users"`
	SignedInAccounts              int64 `json:"signed_in_accounts"`
	SignedOutRecognizedDevices    int64 `json:"signed_out_recognized_devices"`
	SignedOutUnidentifiedInstalls int64 `json:"signed_out_unidentified_installs"`
	RepeatSignedOutSetups         int64 `json:"repeat_signed_out_setups"`
}

// These CTEs use the same proven account links and test-data rules as the
// directory. Existing account evidence still identifies a device when the
// account is excluded from reporting, so a signed-out reset of that test
// device does not introduce a new estimated user.
const audienceEstimateCTEs = `
	report_audience_device_groups AS (
	  SELECT i.device_id_kind, i.device_id_hash,
	         COUNT(*) FILTER (WHERE i.resolved_account_id IS NULL
	           AND i.install_id NOT IN (SELECT install_id FROM report_excluded_installs)) AS signed_out_setups,
	         BOOL_OR(a.id IS NOT NULL) AS has_current_account
	  FROM report_installs i
	  LEFT JOIN accounts a ON a.id = i.resolved_account_id
	  WHERE NOT i.is_web_session
	  GROUP BY i.device_id_kind, i.device_id_hash
	), report_audience_device_counts AS (
	  SELECT COUNT(*) FILTER (WHERE device_id_hash IS NOT NULL AND NOT has_current_account
	           AND signed_out_setups > 0) AS signed_out_recognized_devices,
	         COALESCE(SUM(signed_out_setups) FILTER (WHERE device_id_hash IS NULL), 0)::bigint
	           AS signed_out_unidentified_installs,
	         COALESCE(SUM(signed_out_setups) FILTER (WHERE device_id_hash IS NOT NULL), 0)::bigint
	           AS recognized_signed_out_setups
	  FROM report_audience_device_groups
	), report_audience_estimate AS (
	  SELECT signed_in_accounts + signed_out_recognized_devices + signed_out_unidentified_installs AS estimated_users,
	         signed_in_accounts, signed_out_recognized_devices, signed_out_unidentified_installs,
	         recognized_signed_out_setups - signed_out_recognized_devices AS repeat_signed_out_setups
	  FROM report_audience_device_counts
	  CROSS JOIN (
	    SELECT COUNT(*) AS signed_in_accounts FROM accounts
	    WHERE id::text NOT IN (SELECT id FROM report_excluded_accounts)
	  ) account_count
	)`
