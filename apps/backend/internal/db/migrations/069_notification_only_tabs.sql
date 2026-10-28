-- Existing shared accounts retain their review contract. Recorded claims are
-- separate from counterparty acceptance; no historical row is reclassified.
ALTER TABLE tabs ADD COLUMN recording_mode TEXT NOT NULL DEFAULT 'review'
  CHECK (recording_mode IN ('review','notify'));
-- New notify openings preserve the creator's complete same-currency source
-- receipt until actual Join. NULL is intentionally not fabricated for old rows.
ALTER TABLE tabs ADD COLUMN notify_opening_source_revisions JSONB;
ALTER TABLE tab_entries DROP CONSTRAINT tab_entries_status_check;
ALTER TABLE tab_entries ADD CONSTRAINT tab_entries_status_check
  CHECK (status IN ('pending','accepted','disputed','recorded'));
