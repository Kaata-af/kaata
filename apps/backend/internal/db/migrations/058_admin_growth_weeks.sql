-- Weekly growth keeps each completed week as it was first reported
-- (internal/admin/growth.go freezeClosedWeeks). The accounting is otherwise
-- recomputed on every read from today's install links, so a device that
-- later signs in to another account, is merged into another identity, or
-- loses installs.account_id when its account is purged could move into or
-- out of weeks that already carry a 7% verdict.
--
-- GET /v1/admin/growth writes a row for every week that has ended in Kabul
-- and reuses it while `rules` matches: a fingerprint of OPERATOR_ACCOUNT_IDS
-- and the install/account exclusions in outreach_exclusions. Excluding or
-- including test data, or editing OPERATOR_ACCOUNT_IDS, changes the
-- fingerprint, so those deliberate decisions recalculate the recorded weeks
-- once. Aggregates only: no install or account id is stored here.
CREATE TABLE admin_growth_weeks (
  week         DATE PRIMARY KEY,           -- reporting week start (Monday)
  rules        TEXT NOT NULL,              -- exclusion fingerprint it was recorded under
  new_installs BIGINT NOT NULL,
  retained     BIGINT NOT NULL,
  resurrected  BIGINT NOT NULL,
  churned      BIGINT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
