-- People discovery is now on by default for signed-in Kaata accounts.
-- This is a one-time rollout for existing active accounts, including rows
-- whose old FALSE default cannot be distinguished from an explicit opt-out.
-- Later user choices must survive sign-in, recovery, and subsequent deploys:
-- only this recorded migration changes existing preferences.
ALTER TABLE accounts ALTER COLUMN discovery_enabled SET DEFAULT TRUE;

UPDATE accounts
SET discovery_enabled = TRUE
WHERE NOT discovery_enabled
  AND disabled_at IS NULL
  AND pending_delete_at IS NULL;

-- Anonymous/Ninja profiles live in installs, not accounts. This migration
-- neither creates accounts from those profiles nor makes installs searchable.
