import { APK_VERSION } from "../env";
import { getTrackedDownloadUrl } from "../lib/analytics";
import { useToast } from "./Toast";

export function DownloadButton() {
  // Computed at render time, not at module load, so a freshly-stored source
  // (e.g. user just landed on /?s=foo and immediately navigated to /download)
  // is included. The backend handles the 302 to the real APK.
  const href = getTrackedDownloadUrl();
  const { push } = useToast();
  return (
    <a
      href={href}
      onClick={() => push("Starting download — install when ready.", "success")}
      className="block w-full bg-neutral-900 text-white font-semibold px-8 py-4 rounded-lg hover:bg-neutral-800 transition-colors text-center text-base"
    >
      Download APK · v{APK_VERSION}
    </a>
  );
}
