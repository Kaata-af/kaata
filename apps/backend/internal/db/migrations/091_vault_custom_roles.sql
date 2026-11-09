-- Custom roles narrow preset permissions. The preset remains the role stored
-- in signed events, so existing clients can still read the membership chain.
CREATE TABLE vault_custom_roles (
  id UUID PRIMARY KEY,
  vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  base_role TEXT NOT NULL CHECK (base_role IN ('manager', 'editor', 'clerk', 'viewer')),
  permissions TEXT[] NOT NULL,
  UNIQUE (vault_id, id, base_role),
  CHECK (permissions <@ ARRAY['entry.create', 'entry.amend', 'entry.delete',
    'person.add', 'person.edit', 'group.manage', 'tally_note.add',
    'tally_note.remove', 'vault.settings', 'vault.members']::TEXT[])
);

CREATE UNIQUE INDEX vault_custom_roles_vault_name ON vault_custom_roles(vault_id, lower(name));

ALTER TABLE vault_members ADD COLUMN custom_role_id UUID;
ALTER TABLE vault_members ADD CONSTRAINT vault_members_custom_role_scope
  FOREIGN KEY (vault_id, custom_role_id, role) REFERENCES vault_custom_roles(vault_id, id, base_role);
ALTER TABLE vault_members ADD CONSTRAINT vault_members_custom_role_active
  CHECK (custom_role_id IS NULL OR (account_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL));
CREATE INDEX vault_members_custom_role ON vault_members(custom_role_id) WHERE custom_role_id IS NOT NULL;

-- All membership entry points (including signed chain updates) must clear
-- an assignment when the member leaves, returns, or changes preset role.
CREATE FUNCTION clear_vault_custom_role_on_seat_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    NEW.custom_role_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clear_vault_custom_role_on_seat_change
  BEFORE UPDATE OF role, account_id, revoked_at, accepted_at ON vault_members
  FOR EACH ROW EXECUTE FUNCTION clear_vault_custom_role_on_seat_change();
