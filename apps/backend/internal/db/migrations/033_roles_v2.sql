-- Roles v2 (docs/roles-v2-design.md): widen the role vocabulary to
--   viewer < clerk < editor < manager < owner
-- Phase A ("understanding" release): every layer accepts the new literals;
-- no UI grants them yet. This migration must be live BEFORE any client that
-- can author manager/clerk events ships — a relaxed Go layer writing into
-- an un-relaxed CHECK raises 23514 and (via the fold's error path) would
-- 500 whole push batches.

-- vault_members: the membership mirror the chain fold + REST endpoints write.
-- The inline CHECK from 006 got the default constraint name. (The only other
-- role-CHECKed table, vault_credentials_issued from 009, was dropped by 019's
-- VMC retirement — nothing else pins the enum.)
ALTER TABLE vault_members DROP CONSTRAINT IF EXISTS vault_members_role_check;
ALTER TABLE vault_members ADD CONSTRAINT vault_members_role_check
  CHECK (role IN ('owner', 'manager', 'editor', 'clerk', 'viewer'));
