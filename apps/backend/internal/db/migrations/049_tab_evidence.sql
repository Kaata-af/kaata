-- Minimal shared-record attribution survives deletion of a login account.
-- These UUIDs identify the account that performed an action, not a verified
-- legal identity. Deliberately no account FK on the evidence snapshots.
ALTER TABLE tab_entries
  ADD COLUMN author_evidence_account_id UUID,
  ADD COLUMN author_member_role TEXT CHECK (author_member_role IN ('account','viewer','clerk','editor','manager','owner')),
  ADD COLUMN reviewer_account_id UUID,
  ADD COLUMN reviewer_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN reviewer_party TEXT CHECK (reviewer_party IN ('a','b')),
  ADD COLUMN reviewer_member_role TEXT CHECK (reviewer_member_role IN ('account','viewer','clerk','editor','manager','owner')),
  ADD COLUMN review_semantics_version TEXT;

-- The existing author column was recorded at the action. A deleted author
-- cannot be reconstructed from today's party owner or membership.
UPDATE tab_entries SET author_evidence_account_id = author_account_id
 WHERE author_account_id IS NOT NULL;

-- Recover only the notification for the entry's CURRENT final verdict.
-- A non-NULL actor ID proves this notification records the individual actor.
-- Older notification labels could name the party instead; a NULL actor is
-- ambiguous (legacy or already deleted), so do not turn that label into a
-- person's name. Never fabricate authority roles or semantics versions.
UPDATE tab_entries e
   SET reviewer_account_id = n.actor_account_id,
       reviewer_name = CASE WHEN n.actor_account_id IS NOT NULL THEN n.actor_label ELSE '' END,
       reviewer_party = CASE n.recipient_role WHEN 'a' THEN 'b' ELSE 'a' END
  FROM tab_notifications n
 WHERE n.tab_id = e.tab_id AND n.entry_id = e.id AND n.rev = e.rev
   AND e.kind <> 'void'
   AND ((e.status = 'accepted' AND n.event_kind = 'entry_accepted')
     OR (e.status = 'disputed' AND n.event_kind = 'entry_rejected'));
