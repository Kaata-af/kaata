-- Existing usernames were private sign-in handles. Publication is opt-in;
-- neither an upgrade nor a provider login publishes an existing account.
ALTER TABLE accounts ADD COLUMN discovery_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE FUNCTION people_search_text(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(lower(COALESCE(value,'')), 'يىك۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', 'ییک01234567890123456789')
$$;
CREATE INDEX accounts_discovery_name ON accounts USING gin
  (to_tsvector('simple', people_search_text(COALESCE(NULLIF(display_name,''),name,''))))
  WHERE discovery_enabled AND disabled_at IS NULL AND pending_delete_at IS NULL;
CREATE INDEX accounts_discovery_phone ON accounts(phone_e164)
  WHERE discovery_enabled AND disabled_at IS NULL AND pending_delete_at IS NULL;
CREATE INDEX accounts_discovery_username ON accounts
  (people_search_text(COALESCE(username,'')) text_pattern_ops)
  WHERE discovery_enabled AND disabled_at IS NULL AND pending_delete_at IS NULL;

-- This row is an invitation, NOT a tab-party binding. Only explicit JoinGroup
-- grants access to shared records. A request selector is not a bearer secret:
-- preview and join always authenticate its exact recipient account.
CREATE TABLE people_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL UNIQUE REFERENCES tab_groups(id) ON DELETE CASCADE,
  sender_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
  declined_at TIMESTAMPTZ,
  CHECK(sender_account_id <> recipient_account_id)
);
CREATE INDEX people_requests_recipient ON people_requests(recipient_account_id,created_at DESC);
CREATE INDEX people_requests_pair ON people_requests(sender_account_id,recipient_account_id,created_at DESC);
