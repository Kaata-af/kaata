package admin

// Browser installs are session credentials: each login intentionally gets its
// own UUID. They establish account/platform usage, never a physical app install.
// The old app_version marker is sufficient to recover known browser rows, but
// an unknown platform alone is not evidence that a native install was a browser.
const installReportingCTEs = `
	report_classified_installs AS (
	  SELECT i.*,
	    CASE WHEN platform = 'web' OR (COALESCE(platform, '') IN ('', 'unknown') AND app_version = 'web')
	      THEN 'web' ELSE COALESCE(platform, '') END AS reported_platform,
	    (platform = 'web' OR (COALESCE(platform, '') IN ('', 'unknown') AND app_version = 'web')) IS TRUE AS is_web_session
	  FROM installs i
	),
	report_native_installs AS (
	  SELECT * FROM report_classified_installs WHERE NOT is_web_session
	),
	report_native_active_days AS (
	  SELECT a.* FROM admin_active_days a JOIN report_native_installs i USING (install_id)
	),
	report_native_active_hours AS (
	  SELECT a.* FROM install_active_hours a JOIN report_native_installs i USING (install_id)
	)`

const installMetricCTEs = reportExclusionCTEs + "," + installReportingCTEs
