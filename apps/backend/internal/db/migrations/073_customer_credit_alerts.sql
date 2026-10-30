-- Combined currency alerts are advisory server configuration. They do not
-- change the independent per-currency admission limits or signed money evidence.
-- The all-zero relationship keys the Kaata default, as for credit limits.
CREATE TABLE customer_credit_alerts (
  vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL,
  groups JSONB NOT NULL CHECK (jsonb_typeof(groups) = 'array' AND jsonb_array_length(groups) <= 20),
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (vault_id, relationship_id)
);

-- Preserve a strictly increasing server revision through deletion/recreation,
-- independent of client clocks or two changes within one millisecond.
CREATE TABLE customer_credit_alert_revisions (
  vault_id UUID PRIMARY KEY REFERENCES vaults(vault_id) ON DELETE CASCADE,
  updated_at_ms BIGINT NOT NULL
);
