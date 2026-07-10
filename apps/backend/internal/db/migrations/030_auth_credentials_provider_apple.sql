-- Sign in with Apple: allow provider='apple' in auth_credentials.
--
-- Migration 004 created the table with an inline CHECK (provider IN ('google'))
-- and nothing ever relaxed it, so every POST /v1/auth/apple failed at the
-- credential INSERT with SQLSTATE 23514 — the whole sign-in transaction rolled
-- back and the client saw 401 "apple sign-in failed" even though the native
-- Apple authorization succeeded. Invisible until the first real iOS build:
-- no Go test inserts an 'apple' credential row, and account_identities (013)
-- has no provider CHECK, so the identity layer worked fine in isolation.
--
-- Postgres auto-named the inline column constraint auth_credentials_provider_check.

ALTER TABLE auth_credentials
  DROP CONSTRAINT IF EXISTS auth_credentials_provider_check;

ALTER TABLE auth_credentials
  ADD CONSTRAINT auth_credentials_provider_check CHECK (provider IN ('google', 'apple'));
