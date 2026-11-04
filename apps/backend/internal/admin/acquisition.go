package admin

import (
	"context"

	"github.com/matee/kaata-backend/internal/visit"
)

type AcquisitionSource struct {
	Source              string `json:"source"`
	PlayClicks          int64  `json:"play_clicks"`
	AppStoreClicks      int64  `json:"app_store_clicks"`
	AppleFirstDownloads *int64 `json:"apple_first_downloads"`
	AndroidInstalls     int64  `json:"android_installs"`
	LinkedAccounts      int64  `json:"linked_accounts"`
}

type Acquisition struct {
	Sources           []AcquisitionSource `json:"sources"`
	Unattributed      int64               `json:"unattributed"`
	LegacyIPEstimates int64               `json:"legacy_ip_estimates"`
}

func (s *Service) getAcquisition(ctx context.Context) (Acquisition, error) {
	// Rank each account's native installation history before filtering to
	// known sources. An attributed reinstall cannot take credit for an
	// account whose earliest recorded native installation had another source.
	rows, err := s.pool.Query(ctx, userReportInstalls+`, `+reportExclusionCTEs+`,
		source_keys AS (SELECT unnest($2::text[]) AS source),
		native AS (
		  SELECT i.source, i.attribution_method, i.reported_platform, a.id AS account_id,
		         ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY i.first_seen_at, i.install_id) AS install_order
		  FROM report_installs i
		  LEFT JOIN accounts a ON a.id=i.resolved_account_id
		  WHERE NOT i.is_web_session
		    AND i.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		), classified AS (
		  SELECT *, (reported_platform='android' AND attribution_method='play_referrer' AND source=ANY($2::text[])) IS TRUE AS via_play
		  FROM native
		), installs_by_source AS (
		  SELECT source, COUNT(*) AS installs,
		         COUNT(*) FILTER (WHERE account_id IS NOT NULL AND install_order=1) AS accounts
		  FROM classified WHERE via_play GROUP BY source
		), store_clicks_by_source AS (
		  SELECT source,
		         COUNT(DISTINCT (ip,user_agent,date_trunc('hour',visited_at))) FILTER (WHERE detail='play') AS play_clicks,
		         COUNT(DISTINCT (ip,user_agent,date_trunc('hour',visited_at))) FILTER (WHERE detail='appstore') AS app_store_clicks
		  FROM web_visits
		  WHERE kind='store_click' AND source=ANY($2::text[])
		    AND (ip IS NULL OR ip <> ALL($3::text[]))
		    AND (user_agent IS NULL OR lower(user_agent) !~ $4)
		  GROUP BY source
		), apple_by_source AS (
		  SELECT source, SUM(first_downloads) AS downloads
		  FROM apple_acquisition_daily GROUP BY source
		), coverage AS (
		  SELECT COUNT(*) FILTER (WHERE NOT via_play AND attribution_method IS DISTINCT FROM 'ip_match') AS unattributed,
		         COUNT(*) FILTER (WHERE attribution_method='ip_match') AS legacy_ip
		  FROM classified
		)
		SELECT k.source, COALESCE(w.play_clicks,0), COALESCE(w.app_store_clicks,0),
		       a.downloads, COALESCE(i.installs,0), COALESCE(i.accounts,0),
		       c.unattributed, c.legacy_ip
		FROM source_keys k CROSS JOIN coverage c
		LEFT JOIN installs_by_source i USING (source)
		LEFT JOIN store_clicks_by_source w USING (source)
		LEFT JOIN apple_by_source a USING (source)
	`, s.operatorAccountIDs, visit.AcquisitionSources(), s.operatorIPs, botUARegex)
	var result Acquisition
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var source AcquisitionSource
		if err := rows.Scan(&source.Source, &source.PlayClicks, &source.AppStoreClicks, &source.AppleFirstDownloads, &source.AndroidInstalls, &source.LinkedAccounts,
			&result.Unattributed, &result.LegacyIPEstimates); err != nil {
			return result, err
		}
		result.Sources = append(result.Sources, source)
	}
	return result, rows.Err()
}
