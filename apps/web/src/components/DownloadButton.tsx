import { APK_DOWNLOAD_URL, APK_VERSION } from "../env";
import { reportDownloadClick } from "../lib/analytics";
import { useI18n } from "../lib/i18n";
import { AndroidIcon } from "./StoreButtons";
import { useToast } from "./Toast";

export function DownloadButton() {
  const { push } = useToast();
  const { t } = useI18n();
  // When the button points at the backend's own /v1/download (the resumable
  // local-cache endpoint), the server records the click on the GET itself —
  // firing the count_only beacon too would double-count every web download.
  // The beacon exists for EXTERNAL targets (GitHub asset URL), where the
  // server never sees the download request.
  const servedByBackend = APK_DOWNLOAD_URL.includes("/v1/download");
  return (
    <a
      href={APK_DOWNLOAD_URL}
      target="_blank"
      rel="noopener"
      onClick={() => {
        if (!servedByBackend) reportDownloadClick();
        push(t("download.toast"), "success");
        // The anchor is a NEW-TAB top-level navigation, no `download`
        // attribute — deliberately, from a field repro (2026-07-19, MIUI +
        // Chrome): the same-tab download-anchor click (renderer-initiated
        // download) received all 99 MB and then wedged at "Downloading…"
        // forever, while long-press → "open in new tab" — a top-level
        // navigation that Content-Disposition: attachment converts into a
        // BROWSER-initiated download — completed every time. target="_blank"
        // makes the button take exactly that working path; Chrome closes the
        // spawned tab itself the moment the response turns into a download.
        // The `download` attribute was doing nothing anyway (ignored
        // cross-origin, and both the backend endpoint and the GitHub asset
        // serve attachment) except opting the click into the wedging path.
        //
        // History, so nobody "simplifies" this back: an earlier iframe-based
        // trick broke silently under CSP (frame-src vs the release-asset
        // redirect), and the plain same-tab anchor that replaced it is what
        // wedged on MIUI. No preventDefault, ever — right-click "Save link
        // as" and no-JS keep working.
      }}
      className="flex items-center justify-center gap-2.5 w-full bg-neutral-900 text-white font-semibold px-8 py-4 rounded-lg hover:bg-neutral-800 transition-colors text-center text-base"
    >
      <AndroidIcon className="w-5 h-5 shrink-0" />
      {t("download.button", { version: APK_VERSION })}
    </a>
  );
}
