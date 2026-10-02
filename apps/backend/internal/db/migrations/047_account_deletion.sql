-- Retire old installations so an offline device cannot upload a deleted
-- account's profile again. This marker is not an account or sign-in credential.
ALTER TABLE installs ADD COLUMN account_deleted_at TIMESTAMPTZ;
-- Minimal, non-login receipt: only a matching signed session can confirm an
-- already-completed deletion after its original HTTP response was lost.
ALTER TABLE installs ADD COLUMN deletion_account_id UUID;

-- A closed shared tally retains its original entries and review decisions.
-- Distinguish loss of a participant from an ordinary manual unlink.
ALTER TABLE tabs ADD COLUMN closed_reason TEXT
  CHECK (closed_reason IN ('account_deleted'));
