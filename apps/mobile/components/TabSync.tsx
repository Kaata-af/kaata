import { useEffect } from "react";

import { startTabSyncLoop } from "../lib/tabs/sync";

// Mutual-tab sync host (docs/mutual-tab-design.md §4.6). Mounts once at the
// app root beside <AutoSync/> and starts the tab loop: syncAllTabs on start,
// on every foreground, and every 60 s while active. Renders nothing.
//
// Unlike AutoSync it is UNCONDITIONAL — not gated on app_meta.account_id or
// an active vault. A tab party can exist without any account (D10): a
// shopkeeper who never signed in still holds the party token in tab_links,
// and their tallies must keep flowing. With no links at all the loop's sweep
// is one SELECT a minute and no network. Sign-in state is read per run
// (reconcileTabsFromServer no-ops without a JWT), so a mid-session sign-in
// or sign-out needs no remount.
export function TabSync() {
  useEffect(() => startTabSyncLoop(), []);
  return null;
}
