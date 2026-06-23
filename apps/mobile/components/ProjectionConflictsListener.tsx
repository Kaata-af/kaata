// ProjectionConflictsListener — root-level subscriber that surfaces
// role-gate / server-rejection conflicts as toasts.
//
// Phase 8 D-PROJECTION-CONFLICTS-SURFACE: before this component existed,
// every projection_conflicts row was silent — useProjectionConflicts had
// no consumer anywhere in the app/* tree. A demoted editor's local writes
// would land an "event_rejected_by_local_role_gate" row in the table and
// the user saw nothing. This component subscribes via the same hook and
// emits exactly one toast per new unresolved conflict (deduplicating by
// row id so a multi-tab refresh doesn't double-fire).
//
// It is mounted exactly once at the root of the React tree (in
// _layout.tsx, INSIDE the ToastProvider so useToast() is available).
// Renders nothing visible.

import { useEffect, useRef } from "react";
import { useToast } from "./Toast";
import { t } from "../lib/i18n";
import { useProjectionConflicts, type ProjectionConflictRow } from "../lib/projection-conflicts";

export function ProjectionConflictsListener() {
  const toast = useToast();
  const { rows } = useProjectionConflicts({ limit: 25 });

  // Track which conflict ids we've already surfaced. On first mount we
  // pre-seed with whatever's already in the table so a user with old
  // unresolved rows doesn't get spammed with toasts every cold boot.
  const seenRef = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (seenRef.current === null) {
      // First mount: pre-seed and skip toasting the initial backlog. The
      // home screen could optionally render a banner pointing at a future
      // "resolve conflicts" screen; for now the post-boot stream is
      // enough — every fresh rejection emits a toast.
      seenRef.current = new Set(rows.map((r) => r.id));
      return;
    }
    const seen = seenRef.current;
    let firstFresh: ProjectionConflictRow | null = null;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // Only toast rejections of USER-actionable events (a tally / contact edit
      // the user just made). INTERNAL membership/device/binding events
      // (vault_member_added, vault_device_added, account_bound, …) are
      // re-bound automatically on restore via the witnessed self-admission +
      // quarantine sweep; surfacing "Your role changed — that change couldn't be
      // saved" for that self-healing churn was an alarming false alarm on every
      // restore. Keep them marked seen (so we never toast them) but skip the toast.
      if (firstFresh === null && isUserActionableConflict(row)) {
        firstFresh = row;
      }
    }
    if (firstFresh === null) return;

    // Pick copy based on the conflict kind / detail.reason. Local-role-
    // gate refusals get specific "view only" copy; server-side rejections
    // get a more neutral "your role changed" framing because we have no
    // way to know if the server rejected because of demotion, vault
    // archival, or some other reason. A future "resolve conflicts" screen
    // can show the per-row detail.
    const msg = (() => {
      if (firstFresh.kind === "event_rejected_by_local_role_gate") {
        return t("projectionConflicts.toast.roleGate");
      }
      return t("projectionConflicts.toast.serverRejected");
    })();
    toast.push(msg, "error");
  }, [rows, toast]);

  return null;
}

// A conflict is worth a user-facing toast only when it's about an event the user
// directly authored (a tally or a contact change). Internal membership / device /
// binding events (vault_*, account_bound) are sync plumbing that re-binds itself
// on restore — toasting them reads as a scary "your change couldn't be saved".
function isUserActionableConflict(row: ProjectionConflictRow): boolean {
  const type = typeof row.detail.event_type === "string" ? row.detail.event_type : "";
  if (!type) return true; // unknown → surface it rather than swallow a real reject
  return !(type.startsWith("vault_") || type === "account_bound");
}
