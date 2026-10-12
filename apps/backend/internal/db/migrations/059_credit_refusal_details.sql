-- Owners and managers learn when a limit stopped a clerk (audit #24): which
-- customer, which direction, how much, who, and when. Refusals recorded
-- before this migration keep NULL details and are not listed. Refusals stay
-- outside the ledger; these columns describe an attempt, never money.
ALTER TABLE customer_credit_event_refusals
  ADD COLUMN relationship_id UUID,
  ADD COLUMN entry_type TEXT CHECK (entry_type IN ('debt', 'payment')),
  ADD COLUMN amount_minor BIGINT,
  ADD COLUMN actor_account_id UUID;

ALTER TABLE customer_credit_tab_refusals
  ADD COLUMN vault_id UUID REFERENCES vaults(vault_id) ON DELETE CASCADE,
  ADD COLUMN relationship_id UUID,
  ADD COLUMN entry_type TEXT CHECK (entry_type IN ('debt', 'payment')),
  ADD COLUMN amount_minor BIGINT,
  ADD COLUMN actor_account_id UUID;

CREATE INDEX customer_credit_event_refusals_recent
  ON customer_credit_event_refusals (vault_id, refused_at DESC)
  WHERE relationship_id IS NOT NULL;
CREATE INDEX customer_credit_tab_refusals_recent
  ON customer_credit_tab_refusals (vault_id, refused_at DESC)
  WHERE relationship_id IS NOT NULL;
