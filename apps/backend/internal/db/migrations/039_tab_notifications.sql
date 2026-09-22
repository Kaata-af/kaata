CREATE TABLE tab_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id UUID NOT NULL,
  role TEXT NOT NULL,
  install_id UUID NOT NULL,
  token TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  capability_hash TEXT,
  renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tab_id, role) REFERENCES tab_parties(tab_id, role) ON DELETE CASCADE,
  UNIQUE (tab_id, install_id)
);
CREATE TABLE tab_push_outbox (
  id BIGSERIAL PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES tab_push_subscriptions(id) ON DELETE CASCADE,
  rev BIGINT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  receipt_id TEXT,
  UNIQUE (subscription_id, rev)
);
CREATE INDEX idx_tab_push_due ON tab_push_outbox(next_at);
