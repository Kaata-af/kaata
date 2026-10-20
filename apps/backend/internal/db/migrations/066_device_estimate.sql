-- This analytics identity is separate from an installation, account, or auth
-- credential. Never merge installs or infer ownership from a shared digest.
-- Older clients stay NULL; the mobile client sends only a SHA-256 digest.
ALTER TABLE installs
  ADD COLUMN device_id_hash TEXT,
  ADD COLUMN device_id_kind TEXT,
  ADD CONSTRAINT installs_device_estimate_pair CHECK (
    (device_id_hash IS NULL AND device_id_kind IS NULL)
    OR (
      device_id_hash IS NOT NULL AND device_id_kind IS NOT NULL
      AND device_id_hash ~ '^[0-9a-f]{64}$'
      AND device_id_kind IN ('android_id', 'ios_idfv')
    )
  );

-- Intentionally nonunique: clearing app data creates a new installation whose
-- independent history can share the same estimated device identity.
CREATE INDEX installs_device_estimate ON installs (device_id_kind, device_id_hash)
  WHERE device_id_hash IS NOT NULL;
