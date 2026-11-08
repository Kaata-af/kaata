-- A removal is separate from the original tally's final review. Keep every
-- request instance so stale actions cannot approve a later replacement.
CREATE TABLE tab_entry_removal_requests (
  id UUID PRIMARY KEY,
  tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  entry_id UUID NOT NULL REFERENCES tab_entries(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('a','b')),
  -- Match migration049's durable account-ID action evidence: no name
  -- snapshot and no account FK that could erase the original actor identity.
  requester_account_id UUID NOT NULL,
  requester_member_role TEXT NOT NULL CHECK (requester_member_role IN ('account','editor','manager','owner')),
  expected_rev BIGINT NOT NULL CHECK (expected_rev > 0),
  requested_at_ms BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','declined')),
  decided_by TEXT CHECK (decided_by IN ('a','b')),
  decider_account_id UUID,
  decided_at_ms BIGINT,
  CHECK ((state='pending' AND decided_by IS NULL AND decider_account_id IS NULL AND decided_at_ms IS NULL)
    OR (state<>'pending' AND decided_by IS NOT NULL AND decided_by<>requested_by
      AND decider_account_id IS NOT NULL AND decider_account_id<>requester_account_id AND decided_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX tab_entry_removal_one_pending ON tab_entry_removal_requests(entry_id) WHERE state='pending';
CREATE INDEX tab_entry_removal_history ON tab_entry_removal_requests(tab_id,entry_id);

ALTER TABLE tab_entries
  ADD COLUMN removal_request_id UUID REFERENCES tab_entry_removal_requests(id),
  ADD COLUMN removal_requested_by TEXT CHECK (removal_requested_by IN ('a','b')),
  ADD COLUMN removal_state TEXT CHECK (removal_state IN ('pending','approved','declined')),
  ADD CONSTRAINT tab_entry_removal_shape CHECK (
    (removal_request_id IS NULL AND removal_requested_by IS NULL AND removal_state IS NULL)
    OR (kind='entry' AND status='accepted' AND removal_request_id IS NOT NULL
      AND removal_requested_by IS NOT NULL AND removal_state IS NOT NULL));
