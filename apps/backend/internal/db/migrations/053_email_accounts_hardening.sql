-- Kaata accounts, hardening from the final review (docs/kaata-accounts.md §2).
--
-- A separate file from 052 so a database that already applied 052 still gets it.

-- The language a code's mail went out in. The verify's security notice follows
-- it when the verify request names none.
ALTER TABLE email_codes ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';

-- Session epochs: every sign-in gives the install's credential a fresh random
-- epoch, carried in the session JWT as `ep`, so copies of an older JWT of that
-- install stop authorizing (a reset or a password change ends a stolen copy).
-- Legacy rows and legacy JWTs are epoch 0 and keep matching each other until
-- the next sign-in on that install.
ALTER TABLE auth_credentials ADD COLUMN session_epoch BIGINT NOT NULL DEFAULT 0;

-- One live credential per install, for rows written before that rule held: the
-- old per-provider delete left the previous account's credential in place when
-- an install switched accounts across providers.
DELETE FROM auth_credentials ac
USING installs i
WHERE ac.install_id = i.install_id
  AND i.account_id IS NOT NULL
  AND ac.account_id <> i.account_id;

-- The email dedupe key (Go: emailDedupeKey) in SQL: lowercase, the +tag dropped
-- on every domain, Gmail dots ignored and googlemail.com unified to gmail.com.
-- A Google or Apple account is found by the key of its verified email, the way
-- an 'email' identity is found by its provider_sub. TestEmailKeySQLMatchesGo
-- keeps the two in step.
CREATE FUNCTION kaata_email_key(raw TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  e      TEXT := lower(btrim(raw));
  at     INT;
  local  TEXT;
  domain TEXT;
  plus   INT;
BEGIN
  IF position('@' IN e) = 0 THEN
    RETURN NULL;
  END IF;
  at := length(e) - position('@' IN reverse(e)) + 1;
  local := left(e, at - 1);
  domain := substr(e, at + 1);
  plus := position('+' IN local);
  IF plus > 1 THEN
    local := left(local, plus - 1);
  END IF;
  IF domain IN ('gmail.com', 'googlemail.com') THEN
    local := replace(local, '.', '');
    domain := 'gmail.com';
  END IF;
  RETURN local || '@' || domain;
END
$$;

CREATE INDEX accounts_email_key_idx ON accounts (kaata_email_key(email)) WHERE email_verified;
