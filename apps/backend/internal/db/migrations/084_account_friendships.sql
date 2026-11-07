-- Friendship is account-global and grants no vault, tally, or financial access.
-- One canonical pair serializes crossing requests. A new request rotates id,
-- so a delayed accept/cancel/remove can never act on a replacement request.
CREATE TABLE account_friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_low_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_high_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
  accepted_at TIMESTAMPTZ,
  UNIQUE(account_low_id, account_high_id),
  CHECK(account_low_id < account_high_id),
  CHECK(requested_by IN (account_low_id,account_high_id)),
  CHECK(status <> 'accepted' OR accepted_at IS NOT NULL)
);
CREATE INDEX account_friendships_high_accepted ON account_friendships(account_high_id,account_low_id) WHERE status='accepted';
CREATE INDEX account_friendships_low_accepted ON account_friendships(account_low_id,account_high_id) WHERE status='accepted';
CREATE INDEX account_friendships_incoming ON account_friendships
 ((CASE WHEN requested_by=account_low_id THEN account_high_id ELSE account_low_id END),created_at DESC,id DESC)
 WHERE status='pending';
CREATE INDEX account_friendships_outgoing ON account_friendships(requested_by,created_at DESC) WHERE status='pending';
