-- One-time bootstrap for local dev on a native Postgres install.
-- Run as a superuser (e.g. `postgres`) against the cluster:
--
--   psql -h localhost -U postgres -f backend/scripts/setup-dev-db.sql
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaata') THEN
    CREATE ROLE kaata WITH LOGIN PASSWORD 'kaata_dev';
  END IF;
END
$$;

SELECT 'CREATE DATABASE kaata OWNER kaata'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'kaata')
\gexec

GRANT ALL PRIVILEGES ON DATABASE kaata TO kaata;
