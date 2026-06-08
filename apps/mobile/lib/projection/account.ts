// Projection applier for account_bound events.
//
// Extracted from event-log.ts as part of the Phase 3 modularity refactor.
// Behavior is unchanged from the original event-log.ts implementation.

import type { SQLiteTx } from "../db-tx";
import type { AccountBoundEvent } from "../events";

export async function applyAccountBound(_tx: SQLiteTx, _event: AccountBoundEvent): Promise<void> {
  // No local projection change. The event lives in event_log so:
  //   (a) it forward-syncs to the backend, where projection re-stamps
  //       actor_account_id on every prior event for from_user_id up to
  //       retroactive_through_event_id.
  //   (b) a second-device replay from event_log preserves the binding
  //       for ACL purposes.
  // Mobile UI reads "is signed in" from SecureStore, not from a
  // projection column, so there is nothing to UPDATE locally.
  return;
}
