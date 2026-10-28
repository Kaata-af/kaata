import type { TabLink, TabRecordingMode } from "./types";

export function isTabRecordingMode(mode: unknown): mode is TabRecordingMode {
  return mode === "review" || mode === "notify" || mode === "notify_one_way";
}

export function isNotificationOnlyMode(mode: TabRecordingMode | null | undefined): boolean {
  return mode === "notify" || mode === "notify_one_way";
}

/** The invitee can read a one-way book; only its creator's side can write.
 * Normal Kaata role checks still apply independently. */
export function canWriteSharedTallies(
  link: Pick<TabLink, "role" | "recording_mode" | "recording_mode_known"> | null | undefined,
): boolean {
  if (!link) return true;
  if (link.recording_mode_known === 0) return false;
  if (link.recording_mode != null && !isTabRecordingMode(link.recording_mode)) return false;
  return link.recording_mode !== "notify_one_way" || link.role === "a";
}
