-- Store-badge click tracking for the web funnel.
--
-- The download page stopped serving the APK directly (2026-07-26, Play
-- launch) and now shows Play / App Store badges, which killed the
-- 'download' stage of the web funnel. Store-badge CLICKS become the new
-- funnel stage: the web bundle beacons kind='store_click' to /v1/visit
-- with the same source attribution the old download click carried.
--
-- Two changes, both append-only:
--
-- 1. Widen the web_visits.kind CHECK to allow 'store_click'. The
--    constraint got the auto-generated name web_visits_kind_check when
--    migration 002 created it inline.
--
-- 2. web_visits.detail — a nullable free-slot for kind-specific payload.
--    For 'store_click' it records WHICH store ('play' / 'appstore').
--    Deliberately NOT overloaded onto `source`, which is the
--    QR/marketing-channel slug and must stay campaign-only.

ALTER TABLE web_visits
  DROP CONSTRAINT web_visits_kind_check;

ALTER TABLE web_visits
  ADD CONSTRAINT web_visits_kind_check
  CHECK (kind IN ('visit', 'download', 'store_click'));

ALTER TABLE web_visits
  ADD COLUMN IF NOT EXISTS detail TEXT;
