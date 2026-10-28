-- A shared contact can have one invitation and one join while each currency
-- keeps its existing, immutable financial ledger and history semantics.
CREATE TABLE tab_groups (
  id UUID PRIMARY KEY,
  recording_mode TEXT NOT NULL CHECK (recording_mode IN ('review','notify','notify_one_way')),
  invite_token_hash TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  rev BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  closed_by TEXT CHECK (closed_by IN ('a','b')),
  a_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  a_vault_id UUID REFERENCES vaults(vault_id) ON DELETE SET NULL,
  a_relationship_id UUID,
  b_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  b_vault_id UUID REFERENCES vaults(vault_id) ON DELETE SET NULL,
  b_relationship_id UUID,
  b_joined_at TIMESTAMPTZ,
  b_account_bound_once BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE tabs ADD COLUMN group_id UUID REFERENCES tab_groups(id);
CREATE UNIQUE INDEX idx_tabs_group_currency ON tabs(group_id,currency) WHERE group_id IS NOT NULL;
CREATE INDEX idx_tab_groups_creator_scope ON tab_groups(a_vault_id,a_relationship_id) WHERE closed_at IS NULL;
CREATE INDEX idx_tab_groups_recipient_scope ON tab_groups(b_vault_id,b_relationship_id) WHERE closed_at IS NULL;

CREATE FUNCTION remember_tab_group_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.b_account_bound_once := NEW.b_account_bound_once OR NEW.b_account_id IS NOT NULL;
  IF TG_OP='UPDATE' THEN NEW.b_account_bound_once := NEW.b_account_bound_once OR OLD.b_account_bound_once; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tab_group_binding_guard BEFORE INSERT OR UPDATE ON tab_groups
  FOR EACH ROW EXECUTE FUNCTION remember_tab_group_binding();
