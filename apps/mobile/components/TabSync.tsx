import { useEffect } from "react";

import { startTabSyncLoop } from "../lib/tabs/sync";

// Mutual-tab sync host (docs/mutual-tab-design.md §4.6). Mounts once at the
// app root beside <AutoSync/> and starts the tab loop: syncAllTabs on start,
// on every foreground, and every 60 s while active. Renders nothing.
//
// Unlike AutoSync it is not gated on an active vault. Shared accounts now
// require sign-in; each sweep checks the live session, so a mid-session
// sign-in/sign-out needs no remount. Saved invitation tokens are only used
// for a signed-in legacy claim, never as ongoing read/write authority.
export function TabSync() {
  useEffect(() => startTabSyncLoop(), []);
  return null;
}
