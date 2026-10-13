-- Afghan reporting weeks run Saturday through Friday. Work days are Saturday
-- through Thursday; Friday activity still counts toward the full week's usage.
-- Every caller supplies a local civil timestamp (Kabul, or the preserved UTC
-- date-only history), so the database/session timezone cannot move a boundary.
CREATE FUNCTION admin_bucket_start(bucket TEXT, local_at TIMESTAMP)
RETURNS TIMESTAMP
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT CASE WHEN bucket = 'week'
    THEN date_trunc('week', local_at + INTERVAL '2 days') - INTERVAL '2 days'
    ELSE date_trunc(bucket, local_at)
  END
$$;

-- Keep the previously frozen Monday aggregates intact. They cannot be shifted
-- by two days: those counts cover different activity windows. New Saturday
-- aggregates are recomputed from the retained daily activity/install dates and
-- frozen separately by the application. Default 1 keeps an old replica's
-- Monday writes valid during a rolling deployment; new code explicitly uses 6.
ALTER TABLE admin_growth_weeks
  ADD COLUMN week_starts_on SMALLINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT admin_growth_weeks_calendar CHECK (
    week_starts_on IN (1, 6) AND EXTRACT(DOW FROM week) = week_starts_on
  );
