-- Additive identity metadata. Never infer an old tally's individual author
-- from its party's owner: a kaata member may have written it.
ALTER TABLE tab_entries ADD COLUMN author_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE tab_entries ADD COLUMN author_name TEXT NOT NULL DEFAULT '';
ALTER TABLE tab_notifications ADD COLUMN actor_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE tab_notifications ADD COLUMN actor_install_id UUID;
