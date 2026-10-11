-- Credit policy is server configuration, separate from signed ledger evidence.
CREATE TABLE customer_credit_limits (
  vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL,
  max_collect_minor BIGINT,
  max_pay_minor BIGINT,
  mode TEXT NOT NULL CHECK (mode IN ('warn', 'clerk_block')),
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (vault_id, relationship_id),
  CHECK (max_collect_minor IS NULL OR max_collect_minor BETWEEN 0 AND 999999999999),
  CHECK (max_pay_minor IS NULL OR max_pay_minor BETWEEN 0 AND 999999999999)
);

-- A refused attempt never turns into recorded money on a delayed peer retry.
-- A new user attempt must use a fresh mutation id, even after a policy change.
CREATE TABLE customer_credit_event_refusals (
    vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
    event_id UUID NOT NULL,
    refused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, event_id)
);
CREATE TABLE customer_credit_tab_refusals (
    tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    entry_id UUID NOT NULL,
    refused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tab_id, entry_id)
);

-- Admission checks globally unique mobile entry ids without scanning unrelated
-- vault histories. The predicates match the financial collision guard exactly.
CREATE INDEX events_credit_entry_payload ON events ((payload->>'entry_id'))
  WHERE redacted_at IS NULL AND event_type IN
    ('entry_created','entry_amended','entry_deleted','entry_settled','entry_disputed','entry_accepted');
CREATE INDEX events_credit_entry_target ON events ((COALESCE(local_target_id,target_id::text)))
  WHERE redacted_at IS NULL AND event_type IN
    ('entry_created','entry_amended','entry_deleted','entry_settled','entry_disputed','entry_accepted');
