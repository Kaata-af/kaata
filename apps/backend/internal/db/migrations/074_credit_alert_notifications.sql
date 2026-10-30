-- Credit alerts have their own subscriptions and durable delivery jobs: private
-- customers need neither a shared tab nor access to another party's inbox.
CREATE TABLE credit_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  install_id UUID NOT NULL REFERENCES installs(install_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vault_member_id BIGINT NOT NULL REFERENCES vault_members(id) ON DELETE CASCADE,
  session_epoch BIGINT NOT NULL,
  token TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  preferences JSONB NOT NULL,
  customer_preferences JSONB NOT NULL DEFAULT '[]',
  renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scanned_at TIMESTAMPTZ,
  UNIQUE (vault_id,install_id)
);
CREATE TABLE credit_alert_states (
  subscription_id UUID NOT NULL REFERENCES credit_push_subscriptions(id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('collect','pay')),
  fingerprint TEXT NOT NULL,
  matched BOOLEAN NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(subscription_id,relationship_id,direction)
);
CREATE TABLE credit_push_outbox (
  id BIGSERIAL PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES credit_push_subscriptions(id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('collect','pay')),
  fingerprint TEXT NOT NULL,
  generation BIGINT NOT NULL,
  event_key UUID NOT NULL DEFAULT gen_random_uuid(),
  attempts INT NOT NULL DEFAULT 0,
  next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  receipt_id TEXT,
  claim_token UUID,
  claimed_until TIMESTAMPTZ,
  UNIQUE(subscription_id,relationship_id,direction,generation)
);
CREATE INDEX credit_push_due ON credit_push_outbox(next_at);

-- Provider payloads contain only this random key. Routing/customer information
-- stays here and is resolved through an authenticated installation-bound read.
CREATE TABLE credit_alert_events (
  event_key UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES credit_push_subscriptions(id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('collect','pay')),
  fingerprint TEXT NOT NULL,
  generation BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
