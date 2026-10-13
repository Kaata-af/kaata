package admin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
)

// Test data, decided once and applied to every install metric (2026-10-12):
// the Overview KPIs and chart, weekly growth, cohorts and adoption all leave
// out the same installs, so one "this is test data" decision — an operator
// account in OPERATOR_ACCOUNT_IDS, or an Exclude in Users or Outreach
// (outreach_exclusions) — applies everywhere.
//
// An install is excluded when the operator excluded it (kind 'install'), or
// when it is or was linked to an excluded account: an operator account or an
// account excluded as test data (kind 'account'). "Was" covers the links that
// outlive installs.account_id: account deletion keeps the account's id in
// installs.deletion_account_id after the purge nulls account_id, and a
// credential the install holds for the account (revoked or not) is evidence
// too. So deleting a reviewer or operator account never puts its devices back
// into the counts. A vault exclusion is not an install and only affects the
// vault-level adoption count.
//
// $1 is always OPERATOR_ACCOUNT_IDS. Ids are compared as text, like the
// outreach code, so a hand-inserted non-UUID exclusion cannot fail a report.
const reportExclusionCTEs = `
	report_excluded_accounts AS (
	  SELECT unnest($1::text[]) AS id
	  UNION
	  SELECT id FROM outreach_exclusions WHERE kind = 'account'
	),
	report_excluded_installs AS (
	  SELECT i.install_id FROM installs i
	  WHERE i.install_id::text IN (SELECT id FROM outreach_exclusions WHERE kind = 'install')
	     OR i.account_id::text IN (SELECT id FROM report_excluded_accounts)
	     OR i.deletion_account_id::text IN (SELECT id FROM report_excluded_accounts)
	     OR EXISTS (
	       SELECT 1 FROM auth_credentials c
	       WHERE c.install_id = i.install_id
	         AND c.account_id::text IN (SELECT id FROM report_excluded_accounts)
	     )
	)`

// growthRulesVersion is part of the fingerprint closed weeks are recorded
// under (admin_growth_weeks.rules). Bump it when a change to the accounting
// or exclusion queries should recalculate weeks that are already recorded.
const growthRulesVersion = "growth-rules-v2-saturday"

// exclusionRules fingerprints everything that decides which installs the
// install metrics leave out: OPERATOR_ACCOUNT_IDS and the install and account
// exclusions (not their reasons, which change nothing). A recorded week whose
// fingerprint differs was recorded under other rules and is recalculated.
func (s *Service) exclusionRules(ctx context.Context) (string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT kind || ':' || id FROM outreach_exclusions
		WHERE kind IN ('install', 'account')
		ORDER BY 1
	`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	h := sha256.New()
	h.Write([]byte(growthRulesVersion + "\n"))
	ops := append([]string(nil), s.operatorAccountIDs...)
	sort.Strings(ops)
	last := ""
	for i, id := range ops {
		if i > 0 && id == last {
			continue // config order and duplicates change nothing
		}
		last = id
		h.Write([]byte("operator:" + id + "\n"))
	}
	for rows.Next() {
		var source string
		if err := rows.Scan(&source); err != nil {
			return "", err
		}
		h.Write([]byte(source + "\n"))
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
