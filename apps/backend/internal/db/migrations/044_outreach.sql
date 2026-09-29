-- Operator outreach ledger behind the admin "Outreach" section (2026-09-29).
-- Keyed by the normalized phone string, not a FK: the same number surfaces from
-- installs.self_phone, accounts.phone_e164 and synced person events; installs
-- rows are never deleted while accounts can be; and a contacted number must
-- keep its history even if every source row disappears.
CREATE TABLE outreach_contacts (
  phone_e164         TEXT PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','sent','replied','interested','installed','declined','do_not_contact')),
  contacted_at       TIMESTAMPTZ,      -- most recent send
  first_contacted_at TIMESTAMPTZ,
  replied_at         TIMESTAMPTZ,      -- most recent reply
  contact_count      INTEGER NOT NULL DEFAULT 0,
  note               TEXT NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only touch log: every send, reply, status change and note edit, so
-- the page can show a per-number timeline and compute follow-ups due.
CREATE TABLE outreach_touches (
  id         BIGSERIAL PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('sent','replied','status','note')),
  detail     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_outreach_touches_phone ON outreach_touches (phone_e164, created_at DESC);

-- Operator settings for the section: message templates, link slugs, prefs.
CREATE TABLE outreach_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
