ALTER TABLE account_connection_notifications
  DROP CONSTRAINT account_connection_notifications_shape,
  ADD CONSTRAINT account_connection_notifications_shape CHECK (
    (event_kind='friend_accepted' AND vault_label IS NULL)
    OR (event_kind IN ('vault_invite_rejected','vault_invite_accepted') AND vault_label IS NOT NULL)
  );
