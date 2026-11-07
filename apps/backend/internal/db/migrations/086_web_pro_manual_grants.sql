-- Complimentary access is tracked independently of paid subscription time.
CREATE TABLE web_pro_manual_grants (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > granted_at),
  reason TEXT NOT NULL CHECK (CHAR_LENGTH(reason) BETWEEN 1 AND 240),
  revoked_at TIMESTAMPTZ CHECK (revoked_at >= granted_at),
  revoke_reason TEXT CHECK (CHAR_LENGTH(revoke_reason) BETWEEN 1 AND 240),
  revoke_operation_id UUID UNIQUE,
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_operation_id IS NULL))
);

CREATE INDEX web_pro_manual_grants_history ON web_pro_manual_grants(account_id, granted_at DESC, id DESC);
CREATE INDEX web_pro_manual_grants_expiry ON web_pro_manual_grants(account_id, expires_at DESC) WHERE revoked_at IS NULL;
