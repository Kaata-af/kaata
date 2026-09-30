-- Outreach batch 3 (2026-09-30): the operator's per-number message language.
-- '' follows the session-wide choice (outreach_settings 'pref.message_lang');
-- 'fa' is Dari, 'en' English. A preference, not an outreach event: no touch.
ALTER TABLE outreach_contacts ADD COLUMN lang TEXT NOT NULL DEFAULT ''
  CONSTRAINT outreach_contacts_lang_chk CHECK (lang IN ('', 'en', 'fa'));
