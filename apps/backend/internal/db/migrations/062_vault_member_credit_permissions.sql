-- Credit-limit exceptions are current online configuration, separate from
-- signed membership roles. Bind each exception to a membership seat so a
-- revoked account does not inherit an old bypass when invited again.
CREATE TABLE vault_member_credit_permissions (
  vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vault_member_id BIGINT NOT NULL REFERENCES vault_members(id) ON DELETE CASCADE,
  credit_limit_override TEXT NOT NULL CHECK (credit_limit_override IN ('inherit', 'enforce', 'bypass')),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (vault_id, account_id)
);
