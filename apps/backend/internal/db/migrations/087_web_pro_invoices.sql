-- Document records are separate from the paid subscription ledger. Composite
-- references prevent one account's payment being attached to another account.
-- Public document numbers use 80 random bits from the UUID, skipping its
-- version and variant fields, so a recipient cannot infer billing volume.
ALTER TABLE web_pro_manual_payments ADD UNIQUE (account_id, id);
ALTER TABLE web_pro_orders ADD UNIQUE (account_id, id);

CREATE TABLE web_pro_invoices (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  number TEXT GENERATED ALWAYS AS (
    'KPRO-I-' || upper(left(replace(id::text, '-', ''), 12) || right(replace(id::text, '-', ''), 8))
  ) STORED UNIQUE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('web_pro_monthly', 'web_pro_yearly')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 99999999),
  currency TEXT NOT NULL CHECK (currency = 'AFN'),
  bill_to_name TEXT NOT NULL,
  bill_to_email TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  due_on DATE,
  manual_payment_id UUID UNIQUE,
  provider_order_id UUID UNIQUE,
  paid_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id, manual_payment_id) REFERENCES web_pro_manual_payments(account_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, provider_order_id) REFERENCES web_pro_orders(account_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (num_nonnulls(manual_payment_id, provider_order_id) = CASE WHEN paid_at IS NULL THEN 0 ELSE 1 END),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 1 AND 240),
  CHECK (paid_at IS NULL OR voided_at IS NULL)
);

CREATE INDEX web_pro_invoices_account_history ON web_pro_invoices(account_id, issued_at DESC, id DESC);

-- The confirmed payment supplies the transaction details. Record the recipient
-- and stable receipt number once, so reprints keep the original recipient.
CREATE TABLE web_pro_receipts (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number TEXT GENERATED ALWAYS AS (
    'KPRO-R-' || upper(left(replace(id::text, '-', ''), 12) || right(replace(id::text, '-', ''), 8))
  ) STORED UNIQUE,
  bill_to_name TEXT NOT NULL,
  bill_to_email TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  manual_payment_id UUID UNIQUE,
  provider_order_id UUID UNIQUE,
  FOREIGN KEY (account_id, manual_payment_id) REFERENCES web_pro_manual_payments(account_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (account_id, provider_order_id) REFERENCES web_pro_orders(account_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (num_nonnulls(manual_payment_id, provider_order_id) = 1)
);

CREATE INDEX web_pro_receipts_account ON web_pro_receipts(account_id);
