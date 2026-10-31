-- Web billing is separate from vault permissions and native app access. During
-- the open trial these records never gate an existing route or sync operation.
CREATE TABLE web_pro_subscriptions (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  valid_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE web_pro_orders (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('web_pro_monthly', 'web_pro_yearly')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 99999999),
  currency TEXT NOT NULL DEFAULT 'AFN' CHECK (currency = 'AFN'),
  duration_months INTEGER NOT NULL CHECK (duration_months IN (1,12)),
  item_name TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating','pending','paid','failed','expired')),
  provider_session_id TEXT,
  checkout_url TEXT,
  checkout_expires_at TIMESTAMPTZ,
  provider_transaction_id TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, request_id)
);

CREATE INDEX web_pro_orders_account_created ON web_pro_orders(account_id, created_at DESC);
