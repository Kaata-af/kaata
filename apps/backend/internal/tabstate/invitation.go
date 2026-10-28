// Package tabstate shares authoritative shared-account state predicates across
// the ledger API and server credit projection.
package tabstate

// UnjoinedInvitationSQL expects the tabs table to have alias t. A mere missing
// joined_at is insufficient: legacy binding, reviews and participant deletion
// all preserve a real shared record. The creator's own withdrawal audit rows do
// not turn an unused invitation into a participating shared account.
const UnjoinedInvitationSQL = `(t.closed_reason IS DISTINCT FROM 'account_deleted'
 AND EXISTS(SELECT 1 FROM tab_parties untouched_peer WHERE untouched_peer.tab_id=t.id AND untouched_peer.role='b'
   AND untouched_peer.joined_at IS NULL AND untouched_peer.account_id IS NULL AND NOT untouched_peer.account_bound_once)
 AND NOT EXISTS(SELECT 1 FROM tab_entries participation WHERE participation.tab_id=t.id
   AND (participation.created_by='b' OR participation.reviewer_party='b'
     OR (participation.kind<>'void' AND participation.status IN ('accepted','disputed')))))`
