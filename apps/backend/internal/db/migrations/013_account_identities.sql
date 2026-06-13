-- Sync v2 M1 (docs/sync-v2-architecture.md §4): identity hardening.
--
-- Moves provider bindings out of `accounts` into `account_identities` so an
-- account is a neutral UUID that outlives any auth provider (R1: lossless
-- Google -> phone-OTP migration later). One account can carry many
-- identities ('google' today, 'phone_otp' tomorrow); signing in with any of
-- them resolves to the same account_id, which is already the JWT subject
-- and the key for vault membership — so nothing downstream changes when a
-- new provider ships.
--
-- accounts.google_sub is KEPT this release as a deprecated, dual-written
-- column (rollback safety: a rolled-back binary still upserts by
-- google_sub). It will be dropped in a later release once the
-- account_identities path has soaked. Its NOT NULL constraint is lifted
-- now because future non-google accounts (phone_otp) will have no
-- google_sub at all; the UNIQUE constraint stays (NULLs don't collide).
--
-- Whole migration runs in a single transaction (see db.Migrate).

CREATE TABLE IF NOT EXISTS account_identities (
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,          -- 'google' | 'phone_otp' | future
  provider_sub TEXT NOT NULL,          -- google sub | E.164 phone
  verified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_sub)
);

-- "All identities for account X" — identity linking / merge flows read this.
CREATE INDEX IF NOT EXISTS idx_account_identities_account
  ON account_identities(account_id);

-- Backfill: every existing account is a Google account (006 guaranteed
-- google_sub NOT NULL). verified_at approximates the last time Google
-- actually verified them for us.
INSERT INTO account_identities (account_id, provider, provider_sub, verified_at, created_at)
SELECT id, 'google', google_sub, COALESCE(last_login_at, created_at), created_at
  FROM accounts
 WHERE google_sub IS NOT NULL
ON CONFLICT (provider, provider_sub) DO NOTHING;

-- DEPRECATED: accounts.google_sub survives one release for rollback safety
-- (dual-written by the auth service). Read paths should use
-- account_identities; the legacy lookup in resolveOrCreateAccount is the
-- only sanctioned reader. Dropped in a later migration.
ALTER TABLE accounts ALTER COLUMN google_sub DROP NOT NULL;
COMMENT ON COLUMN accounts.google_sub IS
  'DEPRECATED (M1): provider bindings live in account_identities. Kept dual-written for one release for rollback safety; will be dropped.';
