ALTER TABLE account_friend_notifications RENAME TO account_connection_notifications;
ALTER TABLE account_connection_notifications RENAME COLUMN friend_request_id TO source_id;
ALTER TABLE account_connection_notifications
  ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'friend_accepted',
  ADD COLUMN vault_label TEXT,
  DROP CONSTRAINT account_friend_notifications_friend_request_id_key,
  ADD CONSTRAINT account_connection_notifications_source_key UNIQUE(event_kind,source_id),
  ADD CONSTRAINT account_connection_notifications_shape CHECK (
    (event_kind='friend_accepted' AND vault_label IS NULL)
    OR (event_kind='vault_invite_rejected' AND vault_label IS NOT NULL)
  );

-- Older server processes can still serve friend-only inboxes during rollout.
CREATE VIEW account_friend_notifications AS
SELECT id,source_id AS friend_request_id,recipient_account_id,actor_account_id,actor_label,created_at,read_at
FROM account_connection_notifications
WHERE event_kind='friend_accepted'
WITH LOCAL CHECK OPTION;
