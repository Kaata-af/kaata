-- Keep login identities and ledger evidence recoverable for 30 days.
ALTER TABLE accounts ADD COLUMN pending_delete_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN delete_requested_from_install UUID;
-- Preserve saved archives through account recovery without changing their
-- display/archive timestamp. A cancellation keeps this original deadline.
ALTER TABLE vaults ADD COLUMN archive_purge_not_before TIMESTAMPTZ;
CREATE INDEX accounts_pending_delete_queue ON accounts(pending_delete_at)
  WHERE pending_delete_at IS NOT NULL;
