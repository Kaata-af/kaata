-- Offline receipts extend the same subscription as a verified HesabPay
-- payment. They stay outside the provider's checkout and webhook tables.
CREATE TABLE web_pro_manual_payments (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('web_pro_monthly', 'web_pro_yearly')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 99999999),
  currency TEXT NOT NULL CHECK (currency = 'AFN'),
  duration_months INTEGER NOT NULL CHECK (duration_months IN (1, 12)),
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'other')),
  reference TEXT COLLATE "C" NOT NULL CHECK (reference ~ '^[A-Za-z0-9._/-]{3,64}$'),
  recorded_at TIMESTAMPTZ NOT NULL,
  previous_subscription_expires_at TIMESTAMPTZ,
  subscription_expires_at TIMESTAMPTZ NOT NULL,
  CHECK (subscription_expires_at > recorded_at),
  CHECK (subscription_expires_at > previous_subscription_expires_at)
);

CREATE UNIQUE INDEX web_pro_manual_payments_reference ON web_pro_manual_payments(LOWER(reference));
CREATE INDEX web_pro_manual_payments_history ON web_pro_manual_payments(account_id, recorded_at DESC, id DESC);
