ALTER TABLE account_connection_notifications
 ADD COLUMN vault_id UUID REFERENCES vaults(vault_id) ON DELETE SET NULL,
 ADD COLUMN detail TEXT,
 DROP CONSTRAINT account_connection_notifications_source_key,
 ADD CONSTRAINT account_connection_notifications_source_recipient_key UNIQUE(event_kind,source_id,recipient_account_id),
 DROP CONSTRAINT account_connection_notifications_shape,
 ADD CONSTRAINT account_connection_notifications_shape CHECK(event_kind IN (
  'friend_requested','friend_accepted','friend_rejected','friend_cancelled','friend_removed',
  'vault_invite_requested','vault_invite_accepted','vault_invite_rejected','vault_invite_cancelled',
  'vault_member_removed','vault_member_left','vault_member_role_changed','vault_member_return_requested',
  'shared_invite_requested','shared_invite_cancelled'));

CREATE TABLE account_push_subscriptions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 install_id UUID NOT NULL UNIQUE REFERENCES installs(install_id) ON DELETE CASCADE,
 token TEXT NOT NULL UNIQUE,
 locale TEXT NOT NULL DEFAULT 'en',
 preferences JSONB,
 renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE account_push_outbox (
 id BIGSERIAL PRIMARY KEY,
 subscription_id UUID NOT NULL REFERENCES account_push_subscriptions(id) ON DELETE CASCADE,
 notification_id BIGINT NOT NULL REFERENCES account_connection_notifications(id) ON DELETE CASCADE,
 event_preferences JSONB,
 attempts INT NOT NULL DEFAULT 0,
 next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 receipt_id TEXT,
 UNIQUE(subscription_id,notification_id)
);
CREATE INDEX account_push_due ON account_push_outbox(next_at);

-- Capture eligible devices and their policy inside the action's transaction.
-- Later registration/unmuting cannot replay notifications that happened before
-- registration or while muted. The worker checks both this snapshot and the
-- current policy, current credentials and current request state before sending.
CREATE FUNCTION enqueue_account_connection_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO account_push_outbox(subscription_id,notification_id,event_preferences)
 SELECT s.id,NEW.id,s.preferences FROM account_push_subscriptions s
 WHERE s.account_id=NEW.recipient_account_id AND s.renewed_at>NOW()-INTERVAL '30 days'
 AND EXISTS(SELECT 1 FROM auth_credentials c WHERE c.install_id=s.install_id
   AND c.account_id=s.account_id AND c.revoked_at IS NULL)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER account_connection_push AFTER INSERT ON account_connection_notifications
 FOR EACH ROW EXECUTE FUNCTION enqueue_account_connection_push();
