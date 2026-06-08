-- Phase 2: accounts, vaults, vault membership, audit log.
--
-- Adds the account-level identity layer on top of the per-install
-- auth_credentials table introduced in 004. An "account" is a Google
-- user (identified by their stable `sub` claim). One account can be
-- linked to many installs (signed in on phone A, then on phone B).
--
-- Vaults are the unit of multi-tenancy: every ledger entry, relationship,
-- and shop_profile row on the mobile side belongs to exactly one vault.
-- A vault has one owner (account_id) and zero or more members with
-- 'owner' / 'editor' / 'viewer' roles. In Phase 2 the UI is single-vault
-- (every signed-in account gets one default vault, auto-minted on
-- mobile and registered server-side via POST /v1/vaults), but the SCHEMA
-- supports the full Phase 4 sharing model from day one.
--
-- vault_epoch is bumped on any membership change so clients can detect
-- stale sessions and force a full resync. Phase 3 will read it; Phase 2
-- only writes it.
--
-- This whole migration runs inside a single transaction (see db.Migrate
-- in internal/db/db.go) — either all of it lands, or none of it does.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- accounts: one row per Google identity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub       TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL,
  email_normalized TEXT,
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  name             TEXT,
  picture_url      TEXT,
  locale           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_accounts_email_normalized ON accounts(email_normalized);

-- ---------------------------------------------------------------------------
-- auth_credentials.account_id + revoked_at backfill
--
-- 004 created auth_credentials with (install_id, provider, provider_sub)
-- as the per-install credential record. We retroactively materialise
-- an `accounts` row for every distinct provider_sub already present, and
-- link every existing credential to its account.
-- ---------------------------------------------------------------------------
ALTER TABLE auth_credentials
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Backfill: every existing auth_credentials row was a v0.4 Google sign-in
-- whose ID token had email_verified=TRUE (the verify step in v0.4
-- backend/internal/auth refused to issue a session otherwise). Stamping
-- TRUE is therefore historically accurate. Without this, Phase 4 invite-
-- match flows that gate on email_verified would lock these accounts out.
-- email_normalized is populated using the same lowercase+gmail-dots rule
-- the Go code applies on new sign-ins so invite-match queries find them.
INSERT INTO accounts (google_sub, email, email_normalized, email_verified, name, picture_url, last_login_at)
SELECT DISTINCT ON (provider_sub)
       provider_sub,
       COALESCE(email, ''),
       CASE
         WHEN email IS NULL OR email = '' THEN NULL
         WHEN LOWER(SPLIT_PART(email, '@', 2)) IN ('gmail.com','googlemail.com')
           THEN REPLACE(SPLIT_PART(LOWER(email), '+', 1), '.', '') || '@gmail.com'
         ELSE LOWER(email)
       END,
       TRUE,
       name,
       picture_url,
       last_used_at
  FROM auth_credentials
 WHERE provider = 'google'
 ORDER BY provider_sub, last_used_at DESC
ON CONFLICT (google_sub) DO NOTHING;

UPDATE auth_credentials ac
   SET account_id = a.id
  FROM accounts a
 WHERE ac.provider = 'google'
   AND ac.provider_sub = a.google_sub
   AND ac.account_id IS DISTINCT FROM a.id;

ALTER TABLE auth_credentials ALTER COLUMN account_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- installs: account_id + event_log migration observation timestamp.
-- ---------------------------------------------------------------------------
ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS event_log_migration_observed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_installs_account
  ON installs(account_id) WHERE account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- vaults: one row per ledger tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vaults (
  vault_id          UUID PRIMARY KEY,
  owner_account_id  UUID NOT NULL REFERENCES accounts(id),
  name              TEXT NOT NULL,
  currency          TEXT,
  vault_epoch       BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at       TIMESTAMPTZ,
  pending_delete_by UUID REFERENCES accounts(id),
  pending_delete_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vaults_owner
  ON vaults(owner_account_id) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- vault_members: join table between accounts and vaults with roles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_members (
  id                  BIGSERIAL PRIMARY KEY,
  vault_id            UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  account_id          UUID REFERENCES accounts(id),
  role                TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by          UUID REFERENCES accounts(id),
  invited_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID REFERENCES accounts(id),
  revoked_reason      TEXT,
  invite_email        TEXT,
  invite_token        TEXT,
  invite_expires_at   TIMESTAMPTZ,
  invite_attempts     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_members_active_unique
  ON vault_members(vault_id, account_id)
  WHERE revoked_at IS NULL AND account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vault_members_account_active
  ON vault_members(account_id)
  WHERE revoked_at IS NULL AND accepted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vault_members_vault_active
  ON vault_members(vault_id)
  WHERE revoked_at IS NULL AND accepted_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_members_pending_email
  ON vault_members(vault_id, lower(invite_email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND invite_email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_members_token
  ON vault_members(invite_token) WHERE invite_token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- vault_audit_log: append-only record of membership / vault lifecycle changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  vault_id    UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES accounts(id),
  kind        TEXT NOT NULL,
  target_id   UUID REFERENCES accounts(id),
  payload     JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_vault_time
  ON vault_audit_log(vault_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- backups: tie existing snapshots to (vault_id, account_id).
-- ---------------------------------------------------------------------------
ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS vault_id   UUID REFERENCES vaults(vault_id),
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);

CREATE INDEX IF NOT EXISTS idx_backups_account
  ON backups(account_id, updated_at DESC) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_backups_vault
  ON backups(vault_id, updated_at DESC) WHERE vault_id IS NOT NULL;
