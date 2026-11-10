-- Visible browser heartbeats have their own history. They do not contribute
-- to native app installations, activity, retention or usage counters.
CREATE TABLE web_workspace_days (
  install_id UUID NOT NULL REFERENCES installs(install_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  active_day DATE NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (install_id, account_id, active_day)
);
CREATE INDEX web_workspace_days_active_day_idx ON web_workspace_days(active_day);
CREATE INDEX web_workspace_days_account_id_idx ON web_workspace_days(account_id);
