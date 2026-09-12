-- Keep the original UTC daily history intact. A DATE has no check-in time,
-- so those rows cannot be accurately re-bucketed into Kabul days.
CREATE TABLE analytics_calendar (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  kabul_since DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO analytics_calendar (kabul_since)
VALUES ((NOW() AT TIME ZONE 'Asia/Kabul')::date);

-- Kabul hours begin at :30 UTC. UTC-hour buckets would straddle local
-- midnight and recreate the day-boundary bug. Store instants, not local
-- timestamp strings, and deduplicate repeated check-ins within each hour.
CREATE TABLE install_active_hours (
  install_id UUID NOT NULL REFERENCES installs(install_id) ON DELETE CASCADE,
  active_hour TIMESTAMPTZ NOT NULL,
  had_usage BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (install_id, active_hour)
);
CREATE INDEX idx_active_hours_hour ON install_active_hours(active_hour);

-- Preserve today's already-observed devices when deploying mid-day. The
-- latest check-in is sufficient for today's distinct count, but not for
-- reconstructing earlier hours. Require a matching UTC active-day record:
-- auth can create an installs stub without an actual check-in.
INSERT INTO install_active_hours (install_id, active_hour, had_usage)
SELECT i.install_id,
       date_trunc('hour', i.last_seen_at AT TIME ZONE 'Asia/Kabul') AT TIME ZONE 'Asia/Kabul',
       COALESCE(date_trunc('hour', i.last_activity_at AT TIME ZONE 'Asia/Kabul') =
                date_trunc('hour', i.last_seen_at AT TIME ZONE 'Asia/Kabul'), FALSE)
FROM installs i
JOIN install_active_days d ON d.install_id = i.install_id
  AND d.active_date = (i.last_seen_at AT TIME ZONE 'UTC')::date
CROSS JOIN analytics_calendar c
WHERE (i.last_seen_at AT TIME ZONE 'Asia/Kabul')::date = c.kabul_since;

-- Shared source for the chart, engagement KPIs, retention, and growth.
-- Before the cutover, retain the known UTC dates (disclosed by the API/UI).
-- From the cutover day onward, every date is a Kabul calendar date.
CREATE VIEW admin_active_days AS
SELECT d.install_id, d.active_date
FROM install_active_days d CROSS JOIN analytics_calendar c
WHERE d.active_date < c.kabul_since
UNION
SELECT h.install_id, (h.active_hour AT TIME ZONE 'Asia/Kabul')::date
FROM install_active_hours h CROSS JOIN analytics_calendar c
WHERE (h.active_hour AT TIME ZONE 'Asia/Kabul')::date >= c.kabul_since;

-- Match historical cohort/install dates to the historical activity calendar.
-- Using Kabul install dates against old UTC activity dates would move some
-- installs into the wrong retention day/week.
CREATE VIEW admin_install_dates AS
SELECT i.install_id,
       CASE WHEN (COALESCE(i.installed_at, i.first_seen_at) AT TIME ZONE 'Asia/Kabul')::date < c.kabul_since
         THEN (COALESCE(i.installed_at, i.first_seen_at) AT TIME ZONE 'UTC')::date
         ELSE (COALESCE(i.installed_at, i.first_seen_at) AT TIME ZONE 'Asia/Kabul')::date
       END AS installed_date,
       CASE WHEN (i.first_seen_at AT TIME ZONE 'Asia/Kabul')::date < c.kabul_since
         THEN (i.first_seen_at AT TIME ZONE 'UTC')::date
         ELSE (i.first_seen_at AT TIME ZONE 'Asia/Kabul')::date
       END AS first_seen_date
FROM installs i CROSS JOIN analytics_calendar c;
