-- Drop the three speculative two-party-tab tables created by migration 021.
-- They never gained a single code consumer: the live share feature
-- ("see the full ledger on kaata.af") is served exclusively by
-- shared_ledger_snapshots (migration 025), and the only DML that ever
-- targeted these tables was 021's own CREATEs. The name collision with
-- 024's shared_ledgers already aborted the migration chain once in
-- production (024 was neutered, 025 recreated the snapshot table under a
-- new name); removing the orphans retires that landmine for good.
--
-- Children before parent: shared_ledger_entries and shared_ledger_access
-- both FK to shared_ledgers (their CASCADEs make the order technically
-- optional, but explicit ordering keeps this readable and safe if the
-- constraints ever change). IF EXISTS because a fresh database that never
-- ran 021 (or one where 024's hotfix path already intervened) must not
-- fail here.

DROP TABLE IF EXISTS shared_ledger_entries;
DROP TABLE IF EXISTS shared_ledger_access;
DROP TABLE IF EXISTS shared_ledgers;
