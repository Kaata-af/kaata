-- Migration 028: per-install self identity (operator outreach).
--
-- v1's privacy stance was "the ledger never leaves the device without sign-in",
-- so an anonymous install carried only telemetry (counters, locale, platform)
-- and the admin dashboard could show no name/phone for it. Matee needs to reach
-- the people actually using kaata (churn interviews — see docs/backlog.md), so
-- each install now reports its OWN self profile on check-in: the shopkeeper's
-- display name, E.164 phone, and shop name.
--
-- IMPORTANT scope: this is ONLY the local-self user (the shopkeeper themselves),
-- NEVER their customers/suppliers. The customer ledger still never leaves the
-- device. These three columns are display/identity only — never an ACL key.
--
-- All three are nullable and only populated from the install's NEXT check-in on
-- an app build that sends them (NULL on every existing row until then).
ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS self_name  TEXT,
  ADD COLUMN IF NOT EXISTS self_phone TEXT,
  ADD COLUMN IF NOT EXISTS shop_name  TEXT;
