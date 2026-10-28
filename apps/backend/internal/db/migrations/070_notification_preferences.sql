-- Personal delivery preferences belong to an authenticated installation and
-- subscription. NULL retains the legacy client's existing delivery behavior.
-- Durable inbox rows and every financial record remain independent of alerts.
ALTER TABLE tab_push_subscriptions ADD COLUMN preferences JSONB;
ALTER TABLE tab_push_subscriptions ADD CONSTRAINT tab_push_preferences_object
  CHECK (preferences IS NULL OR jsonb_typeof(preferences) = 'object');
