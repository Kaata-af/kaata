-- Durable, party-scoped notification history, independent of push permissions,
-- devices and provider receipts. Entries are immutable; reviews append events.
CREATE TABLE tab_notifications (
  id BIGSERIAL PRIMARY KEY,
  tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  rev BIGINT NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('a','b')),
  event_kind TEXT NOT NULL,
  -- No FK: append queues its notification before inserting its entry in the SAME tx.
  entry_id UUID,
  actor_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tab_id, rev)
);
CREATE INDEX idx_tab_notifications_party ON tab_notifications(tab_id, recipient_role, id DESC);
CREATE TABLE tab_notification_reads (
  notification_id BIGINT NOT NULL REFERENCES tab_notifications(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id, notification_id)
);
