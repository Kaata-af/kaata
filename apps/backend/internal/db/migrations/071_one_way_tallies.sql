-- Add a creator-only recording contract without changing existing links or rows.
ALTER TABLE tabs DROP CONSTRAINT tabs_recording_mode_check;
ALTER TABLE tabs ADD CONSTRAINT tabs_recording_mode_check
  CHECK (recording_mode IN ('review','notify','notify_one_way'));
