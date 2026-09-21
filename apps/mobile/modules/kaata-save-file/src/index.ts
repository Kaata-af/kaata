// apps/mobile/modules/kaata-save-file/src/index.ts
//
// "Save to phone" done the way each OS actually wants it.
//
// Why this exists: the old path used expo-file-system's directory picker on
// both platforms, and it was broken on both. On Android 11+ the system
// forbids that picker from granting the Downloads folder or the storage root,
// so users were bounced from folder to folder ("keeps asking for a new folder
// due to privacy"). On iOS the picker round-trip crashed the app with an
// uncaught JS exception during the tap's re-render, reproduced on 1.1.1 from
// the store. Replacing the mechanism removes both.
//
//   Android  MediaStore.Downloads insert + stream copy. Lands in the public
//            Downloads folder, visible in Files, no picker, and on API 29+ no
//            permission at all. Below 29 the module reports E_UNSUPPORTED and
//            the caller falls back to the share sheet rather than requesting
//            WRITE_EXTERNAL_STORAGE for a shrinking cohort.
//   iOS      UIDocumentPickerViewController(forExporting:asCopy:) — the
//            system's own "Save to Files" for ONE file. The user picks the
//            destination for that file; no directory grant, no security-scoped
//            bookkeeping on our side.
//
// Both resolve to the display name the OS actually used (providers dedupe),
// or null when the user backed out. Errors carry a `code`.

import { Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

export type SaveFileResult = {
  /** The name the OS created — may differ from the requested one (dedupe). */
  displayName: string;
  /** Where it went (content:// on Android, file:// on iOS). Informational. */
  uri: string;
};

type NativeKaataSaveFile = {
  saveToDownloads(sourceUri: string, fileName: string, mimeType: string): Promise<SaveFileResult>;
  exportFile(sourceUri: string, fileName: string): Promise<SaveFileResult | null>;
};

let _native: NativeKaataSaveFile | null = null;
function getNative(): NativeKaataSaveFile {
  if (_native) return _native;
  _native = requireNativeModule<NativeKaataSaveFile>("KaataSaveFile");
  return _native;
}

/** Error codes the native side raises; callers branch on these, never on text. */
export const SAVE_FILE_ERR = {
  /** Android < 10: MediaStore.Downloads doesn't exist. Fall back to share. */
  UNSUPPORTED: "E_UNSUPPORTED",
  /** The source file we were asked to copy isn't readable. */
  SOURCE: "E_SOURCE",
  /** The OS refused to create or write the destination. */
  WRITE: "E_WRITE",
  /** iOS only: nothing to present the picker on. */
  NO_VIEW: "E_NO_VIEW",
} as const;

/**
 * Save `sourceUri` (a file we already wrote, e.g. the printed PDF) as
 * `fileName` where the user will find it. Resolves null when the user
 * cancels (iOS picker). Throws with `code` on failure.
 */
export async function saveFileToPhone(
  sourceUri: string,
  fileName: string,
  mimeType: string,
): Promise<SaveFileResult | null> {
  if (Platform.OS === "android") {
    return getNative().saveToDownloads(sourceUri, fileName, mimeType);
  }
  if (Platform.OS === "ios") {
    return getNative().exportFile(sourceUri, fileName);
  }
  const err = new Error("kaata-save-file: unsupported platform") as Error & { code: string };
  err.code = SAVE_FILE_ERR.UNSUPPORTED;
  throw err;
}
