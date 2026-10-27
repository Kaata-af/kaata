-- Freeze the denomination of legacy signed events before the entry default
-- becomes independent. Existing amounts are never converted or rescaled.
ALTER TABLE vaults ADD COLUMN legacy_currency TEXT;
ALTER TABLE vaults ADD COLUMN default_entry_currency TEXT;
UPDATE vaults SET legacy_currency=COALESCE(NULLIF(currency,''),'AFN'),
  default_entry_currency=COALESCE(NULLIF(currency,''),'AFN');
ALTER TABLE vaults ALTER COLUMN legacy_currency SET NOT NULL;
ALTER TABLE vaults ALTER COLUMN default_entry_currency SET NOT NULL;

CREATE FUNCTION preserve_vault_legacy_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.legacy_currency := COALESCE(NULLIF(NEW.legacy_currency,''),NULLIF(NEW.currency,''),'AFN');
    NEW.default_entry_currency := COALESCE(NULLIF(NEW.default_entry_currency,''),NEW.legacy_currency);
  ELSE
    NEW.legacy_currency := OLD.legacy_currency;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vaults_preserve_legacy_currency BEFORE INSERT OR UPDATE ON vaults
  FOR EACH ROW EXECUTE FUNCTION preserve_vault_legacy_currency();

ALTER TABLE customer_credit_limits ADD COLUMN currency TEXT;
UPDATE customer_credit_limits p SET currency=v.legacy_currency FROM vaults v WHERE v.vault_id=p.vault_id;
ALTER TABLE customer_credit_limits ALTER COLUMN currency SET NOT NULL;
ALTER TABLE customer_credit_limits DROP CONSTRAINT customer_credit_limits_pkey;
ALTER TABLE customer_credit_limits ADD PRIMARY KEY(vault_id,relationship_id,currency);
CREATE FUNCTION default_credit_policy_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS NULL OR NEW.currency='' THEN
    SELECT legacy_currency INTO NEW.currency FROM vaults WHERE vault_id=NEW.vault_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_credit_default_currency BEFORE INSERT ON customer_credit_limits
  FOR EACH ROW EXECUTE FUNCTION default_credit_policy_currency();

-- The service serializes and enforces one open binding per denomination;
-- this index supports its currency-scoped history and conflict lookup.
CREATE INDEX idx_tabs_currency ON tabs(currency,id);
CREATE INDEX idx_tab_parties_currency_scope ON tab_parties(vault_id,relationship_id,tab_id)
  WHERE vault_id IS NOT NULL AND relationship_id IS NOT NULL;

ALTER TABLE customer_credit_event_refusals ADD COLUMN currency TEXT;
UPDATE customer_credit_event_refusals r SET currency=v.legacy_currency FROM vaults v WHERE v.vault_id=r.vault_id;
CREATE TRIGGER customer_credit_refusal_currency BEFORE INSERT ON customer_credit_event_refusals
  FOR EACH ROW EXECUTE FUNCTION default_credit_policy_currency();
