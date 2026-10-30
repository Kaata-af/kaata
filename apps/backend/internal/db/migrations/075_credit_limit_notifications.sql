-- Shared owner/admin notification configuration is independent of combined
-- alert rules and per-currency admission policies. Missing rows inherit the
-- Kaata default; with neither row present, existing books remain opted out.
-- Rollout: stop/replace old backend notification workers before applying this
-- migration. Their three-column ON CONFLICT cannot infer the expanded watch
-- uniqueness below. Older MOBILE clients remain compatible with the new server.
CREATE TABLE customer_credit_limit_notifications (
  vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY(vault_id,relationship_id)
);
CREATE TABLE customer_credit_limit_notification_revisions (
  vault_id UUID PRIMARY KEY REFERENCES vaults(vault_id) ON DELETE CASCADE,
  updated_at_ms BIGINT NOT NULL
);

-- An old app can keep receiving combined alerts without receiving an ordinary
-- limit event that it cannot validate or route.
ALTER TABLE credit_push_subscriptions ADD COLUMN limit_alerts BOOLEAN NOT NULL DEFAULT FALSE;

-- Each currency rearms independently. The empty key preserves all existing
-- combined alert episodes, receipts and opaque provider event keys.
ALTER TABLE credit_alert_states ADD COLUMN watch_key TEXT NOT NULL DEFAULT '';
ALTER TABLE credit_alert_states DROP CONSTRAINT credit_alert_states_pkey;
ALTER TABLE credit_alert_states ADD PRIMARY KEY(subscription_id,relationship_id,direction,watch_key);
ALTER TABLE credit_push_outbox ADD COLUMN watch_key TEXT NOT NULL DEFAULT '';
DO $$ DECLARE legacy_constraint TEXT; BEGIN
  SELECT conname INTO STRICT legacy_constraint FROM pg_constraint
    WHERE conrelid='credit_push_outbox'::regclass AND contype='u';
  EXECUTE format('ALTER TABLE credit_push_outbox DROP CONSTRAINT %I',legacy_constraint);
END $$;
ALTER TABLE credit_push_outbox ADD UNIQUE(subscription_id,relationship_id,direction,watch_key,generation);
ALTER TABLE credit_alert_events ADD COLUMN watch_key TEXT NOT NULL DEFAULT '';
