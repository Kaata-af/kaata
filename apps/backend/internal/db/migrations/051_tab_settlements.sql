-- A zero-balance chapter boundary shared by both parties. No entries are
-- deleted or rewritten: future entries have seq > through_seq, even when
-- their user-supplied occurred_at timestamp is backdated.
CREATE TABLE tab_settlements (
  id UUID PRIMARY KEY,
  tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  rev BIGINT NOT NULL CHECK (rev > 0),
  through_seq BIGINT NOT NULL CHECK (through_seq > 0),
  settled_at_ms BIGINT NOT NULL CHECK (settled_at_ms > 0),
  created_by TEXT NOT NULL CHECK (created_by IN ('a','b')),
  -- Immutable action snapshots: no FK to the deletable login/profile.
  actor_account_id UUID NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_member_role TEXT NOT NULL CHECK (actor_member_role IN ('account','editor','manager','owner')),
  semantics_version TEXT NOT NULL,
  UNIQUE (tab_id, through_seq),
  UNIQUE (tab_id, rev)
);
