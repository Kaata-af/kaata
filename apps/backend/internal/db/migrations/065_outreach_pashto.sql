-- Language preferences are mutable operator settings, not historical events.
-- Preserve existing values while allowing Pashto alongside English and Dari.
ALTER TABLE outreach_contacts DROP CONSTRAINT outreach_contacts_lang_chk;
ALTER TABLE outreach_contacts ADD CONSTRAINT outreach_contacts_lang_chk
  CHECK (lang IN ('', 'en', 'fa', 'ps'));
