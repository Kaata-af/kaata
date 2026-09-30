-- Outreach batch 2 (2026-09-30): opened-vs-sent, outcomes, source exclusions,
-- optimistic versioning. Opening a WhatsApp chat is not sending: pending_since
-- holds a contact from the moment its chat was opened until an outcome is
-- recorded, so an interrupted session resumes from the server instead of
-- messaging a number twice. version is bumped on every write and checked by
-- the outcome endpoint, because two dashboard tabs can hold the same contact.
-- Column-level CHECKs were auto-named by Postgres; drop whatever check
-- constraints exist and re-add named ones so the next widening is a plain
-- DROP CONSTRAINT.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'outreach_contacts'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE outreach_contacts DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'outreach_touches'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE outreach_touches DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE outreach_contacts ADD CONSTRAINT outreach_contacts_status_chk
  CHECK (status IN ('new','sent','replied','interested','installed','declined','do_not_contact','no_whatsapp','invalid'));
ALTER TABLE outreach_touches ADD CONSTRAINT outreach_touches_kind_chk
  CHECK (kind IN ('sent','replied','status','note','opened','skipped','retry'));
ALTER TABLE outreach_contacts ADD COLUMN opened_at     TIMESTAMPTZ;                 -- last chat open
ALTER TABLE outreach_contacts ADD COLUMN pending_since TIMESTAMPTZ;                 -- opened, no outcome yet
ALTER TABLE outreach_contacts ADD COLUMN skipped_at    TIMESTAMPTZ;                 -- "skip for now"
ALTER TABLE outreach_contacts ADD COLUMN open_count    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outreach_contacts ADD COLUMN version       BIGINT  NOT NULL DEFAULT 0;  -- bumped on every write

-- Operator-verified test sources. Excluding a source drops only that source's
-- contribution to a number: a test book cannot hide a number a real book also
-- holds. Keyed by kind + id text (no FK) so an exclusion outlives the row it
-- names and the page can still show what was excluded.
CREATE TABLE outreach_exclusions (
  kind       TEXT NOT NULL CHECK (kind IN ('vault','account','install')),
  id         TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, id)
);
