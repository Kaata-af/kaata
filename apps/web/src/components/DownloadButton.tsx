import { APK_DOWNLOAD_URL, APK_VERSION } from "../env";
import { reportDownloadClick } from "../lib/analytics";
import { useI18n } from "../lib/i18n";
import { AndroidIcon } from "./StoreButtons";
import { useToast } from "./Toast";

// Start the APK download without visibly navigating the page.
//
// The APK now lives on GitHub Releases (cross-origin). A plain <a href> to that
// URL makes the tab visibly bounce through github.com before the 302 → CDN
// download kicks in — the "it takes me to GitHub for a sec" flash. Routing the
// click through a hidden, throwaway iframe keeps the user on the download page
// and the download "just starts": the asset is served `Content-Disposition:
// attachment`, so the frame only ever receives a download, never a document
// (so X-Frame-Options / framing rules don't apply). The site sends no CSP, so
// the frame's cross-origin navigation isn't blocked.
//
// Returns false if the DOM isn't usable, so the caller falls back to the
// anchor's normal navigation (still downloads, just with the flash). The <a>
// keeps its href so right-click → "Save link as" and no-JS both still work.
function startHiddenDownload(url: string): boolean {
  try {
    if (typeof document === "undefined") return false;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.display = "none";
    iframe.src = url;
    document.body.appendChild(iframe);
    window.setTimeout(() => iframe.remove(), 120_000);
    return true;
  } catch {
    return false;
  }
}

export function DownloadButton() {
  const { push } = useToast();
  const { t } = useI18n();
  return (
    <a
      href={APK_DOWNLOAD_URL}
      download
      onClick={(e) => {
        reportDownloadClick();
        push(t("download.toast"), "success");
        // If we triggered the download invisibly, suppress the tab navigation.
        if (startHiddenDownload(APK_DOWNLOAD_URL)) e.preventDefault();
      }}
      className="flex items-center justify-center gap-2.5 w-full bg-neutral-900 text-white font-semibold px-8 py-4 rounded-lg hover:bg-neutral-800 transition-colors text-center text-base"
    >
      <AndroidIcon className="w-5 h-5 shrink-0" />
      {t("download.button", { version: APK_VERSION })}
    </a>
  );
}
