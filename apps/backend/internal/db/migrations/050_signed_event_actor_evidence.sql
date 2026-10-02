-- account_id is a live account FK that account deletion detaches. For signed
-- events it is also part of the original canonical envelope: changing that
-- envelope invalidates its signature and makes surviving members drop history.
-- Retain only the original opaque actor UUID, without a live account FK.
ALTER TABLE events ADD COLUMN signed_actor_account_id UUID;

UPDATE events SET signed_actor_account_id = account_id
WHERE NULLIF(event_sig_b64, '') IS NOT NULL;

-- Capture at insertion, including an originally NULL pre-sign-in actor. Never
-- COALESCE this field with a later account binding. The trigger also protects
-- writes from an older server during deployment. Already-detached historical
-- actors cannot be reconstructed and remain unknown.
CREATE FUNCTION preserve_signed_event_actor() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.signed_actor_account_id := CASE
      WHEN NULLIF(NEW.event_sig_b64, '') IS NOT NULL THEN NEW.account_id
      ELSE NULL
    END;
  ELSE
    NEW.signed_actor_account_id := OLD.signed_actor_account_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signed_event_actor_evidence
BEFORE INSERT OR UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION preserve_signed_event_actor();
