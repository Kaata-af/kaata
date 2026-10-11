-- Kaata accounts: email + password (docs/kaata-accounts.md §2).
--
-- Next to Google and Apple, anyone can now create a Kaata account with an
-- email address (proven by an emailed 6-digit code) and a password. The
-- password sign-in identity is account_identities ('email', email_key): its
-- primary key makes "one password account per mailbox" a database guarantee.
--
-- This file takes 052 from the unshipped store-review login
-- (052_auth_credentials_provider_review.sql, deleted). A dev database that
-- applied that file may hold 'review' credential rows, so they go first or the
-- new CHECK could not be added. Production never ran it.
DELETE FROM auth_credentials WHERE provider NOT IN ('google', 'apple', 'email');
ALTER TABLE auth_credentials DROP CONSTRAINT IF EXISTS auth_credentials_provider_check;
ALTER TABLE auth_credentials ADD CONSTRAINT auth_credentials_provider_check
  CHECK (provider IN ('google', 'apple', 'email'));

-- Optional private sign-in handle. Stored canonical (lowercase). Never shown to
-- other users, never in tab/inbox/invite/bill payloads, never a trust key.
ALTER TABLE accounts ADD COLUMN username TEXT;
CREATE UNIQUE INDEX accounts_username_key ON accounts (username) WHERE username IS NOT NULL;
ALTER TABLE accounts ADD CONSTRAINT accounts_username_format
  CHECK (username IS NULL OR username ~ '^[a-z][a-z0-9_.]{2,29}$');

CREATE TABLE account_passwords (
  account_id    UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,        -- PHC string, argon2id
  norm_version  SMALLINT NOT NULL,    -- password canonicalization version (§3)
  login_email   TEXT NOT NULL,        -- the proven sign-in address, as typed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Emailed one-time codes. Only an HMAC of each code is stored.
CREATE TABLE email_codes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose             TEXT NOT NULL CHECK (purpose IN ('signup', 'reset', 'setup')),
  email               TEXT NOT NULL,   -- as typed, for display and delivery
  email_key           TEXT NOT NULL,   -- dedupe key (§4)
  account_id          UUID REFERENCES accounts(id) ON DELETE CASCADE, -- reset/setup target
  code_hash           BYTEA NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  consumed_by_install UUID
);
CREATE INDEX idx_email_codes_key ON email_codes (email_key, purpose, created_at DESC);

-- Request/failure ledger for throttles. Rows carry no plaintext identifier.
CREATE TABLE auth_throttle_events (
  id         BIGSERIAL PRIMARY KEY,
  scope      TEXT NOT NULL,           -- 'mail' | 'code_fail' | 'login'
  key        BYTEA NOT NULL,          -- HMAC(server key, scope || identifier)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_auth_throttle ON auth_throttle_events (scope, key, created_at DESC);

-- Outgoing mail, written in the same transaction as the code it carries. Bodies are
-- cleared once sent; rows are purged after 2 days.
CREATE TABLE email_outbox (
  id              BIGSERIAL PRIMARY KEY,
  to_addr         TEXT NOT NULL,
  subject         TEXT NOT NULL,
  text_body       TEXT,
  html_body       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  not_after       TIMESTAMPTZ NOT NULL,  -- give up after this (codes expire)
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  last_error      TEXT
);
CREATE INDEX idx_email_outbox_due ON email_outbox (next_attempt_at) WHERE sent_at IS NULL;
