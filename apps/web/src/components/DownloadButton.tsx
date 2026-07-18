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
      download
      onClick={() => {
        if (!servedByBackend) reportDownloadClick();
        push(t("download.toast"), "success");
        // Let the anchor perform the download natively — no preventDefault, no
        // hidden iframe. The APK lives on GitHub Releases (cross-origin) and is
        // served `Content-Disposition: attachment`, so clicking the link starts
        // the download without navigating the page away.
        //
        // We used to route the click through a hidden throwaway iframe to hide a
        // brief github.com "flash", suppressing the anchor with preventDefault
        // when the iframe was created. That silently broke the day a CSP was
        // added: GitHub 302-redirects release assets to
        // release-assets.githubusercontent.com, which our `frame-src` doesn't
        // allow, so the framed download was blocked WHILE preventDefault had
        // already cancelled the real link — the toast fired but nothing
        // downloaded. Top-level navigation isn't governed by `frame-src`, so the
        // plain anchor just works, and it keeps right-click "Save link as" and
        // no-JS working too.
      }}
      className="flex items-center justify-center gap-2.5 w-full bg-neutral-900 text-white font-semibold px-8 py-4 rounded-lg hover:bg-neutral-800 transition-colors text-center text-base"
    >
      <AndroidIcon className="w-5 h-5 shrink-0" />
      {t("download.button", { version: APK_VERSION })}
    </a>
  );
}
