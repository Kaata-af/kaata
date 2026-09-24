-- Per-mutation identity for actionable alerts. No money or credentials in payloads.
ALTER TABLE tab_push_outbox ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'updated';
ALTER TABLE tab_push_outbox ADD COLUMN entry_id UUID;
-- A deleted account must not make its already-claimed invitation claimable again.
ALTER TABLE tab_parties ADD COLUMN account_bound_once BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE tab_parties SET account_bound_once=TRUE WHERE account_id IS NOT NULL;
CREATE FUNCTION remember_tab_account_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.account_bound_once := NEW.account_bound_once OR NEW.account_id IS NOT NULL;
 IF TG_OP='UPDATE' THEN NEW.account_bound_once := NEW.account_bound_once OR OLD.account_bound_once; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tab_party_binding_guard BEFORE INSERT OR UPDATE ON tab_parties
 FOR EACH ROW EXECUTE FUNCTION remember_tab_account_binding();
