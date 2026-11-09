-- Account notifications share the tab inbox's numeric cursor without
-- requiring a tally, vault or push registration.
CREATE TABLE account_friend_notifications (
  id BIGINT PRIMARY KEY DEFAULT nextval('tab_notifications_id_seq'),
  friend_request_id UUID NOT NULL UNIQUE,
  recipient_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  CHECK (recipient_account_id <> actor_account_id)
);
CREATE INDEX account_friend_notifications_recipient ON account_friend_notifications(recipient_account_id,id DESC);
CREATE INDEX account_friend_notifications_actor ON account_friend_notifications(actor_account_id);
