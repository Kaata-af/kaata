-- Per-install authentication credentials. One row per (install, provider).
--
-- provider_sub is the stable identifier from the auth provider (Google's
-- `sub` claim in the ID token). It survives email changes on the underlying
-- Google account, so it's the canonical identity key — not email.
--
-- email + name + picture_url are captured at sign-in for display purposes
-- only ("Signed in as ahmad@gmail.com" in the Settings row). They are NOT
-- the identity key and MUST NOT be used as one — per the phase-2 roadmap
-- principle that phone numbers are the canonical user identity, Google
-- account info is an auth credential attached to the install, never the
-- identity itself. See memory/auth_model_decision.md.
--
-- An install can have at most one credential per provider — re-signing-in
-- with a different Google account on the same install replaces the row via
-- ON CONFLICT (install_id, provider). One Google user (one provider_sub)
-- can be attached to multiple installs over time (signed in on phone A, lost
-- it, signed back in on phone B); the index on (provider, provider_sub)
-- supports the cross-device backup-restore lookup later.

CREATE TABLE IF NOT EXISTS auth_credentials (
  id BIGSERIAL PRIMARY KEY,
  install_id UUID NOT NULL REFERENCES installs(install_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  provider_sub TEXT NOT NULL,
  email TEXT,
  name TEXT,
  picture_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (install_id, provider)
);

-- Cross-device lookup: "given a Google user, find every install they've
-- ever signed in on." Used by the upcoming backup-restore flow when a user
-- signs in on a new phone — we surface backups from their prior installs.
CREATE INDEX IF NOT EXISTS idx_auth_credentials_provider_sub
  ON auth_credentials(provider, provider_sub);
