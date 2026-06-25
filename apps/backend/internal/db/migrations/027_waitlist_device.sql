-- Migration 027: record the device a waitlist signup came from.
--
-- `platform` is which STORE the visitor asked about (ios/android/stores —
-- their explicit choice). `device` is what they were actually browsing on,
-- derived server-side from the User-Agent ('ios' | 'android' | 'other'), so
-- the operator can see e.g. "iPhone users asking for the App Store". NULL for
-- rows written before this column existed.
ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS device TEXT;
