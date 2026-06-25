import { APK_DOWNLOAD_URL, APK_VERSION } from "../env";
import { reportDownloadClick } from "../lib/analytics";
import { useI18n } from "../lib/i18n";
import { AndroidIcon } from "./StoreButtons";
import { useToast } from "./Toast";

export function DownloadButton() {
  // The href is the SAME-ORIGIN APK (served by the static host alongside
  // this page) — previously it navigated to api.kaata.af/v1/download, so a
  // backend outage replaced kaata.af with a browser error page and killed
  // the funnel at its final step. The click count still reaches the
  // backend best-effort via reportDownloadClick().
  const { push } = useToast();
  const { t } = useI18n();
  return (
    <a
      href={APK_DOWNLOAD_URL}
      onClick={() => {
        reportDownloadClick();
        push(t("download.toast"), "success");
      }}
      className="flex items-center justify-center gap-2.5 w-full bg-neutral-900 text-white font-semibold px-8 py-4 rounded-lg hover:bg-neutral-800 transition-colors text-center text-base"
    >
      <AndroidIcon className="w-5 h-5 shrink-0" />
      {t("download.button", { version: APK_VERSION })}
    </a>
  );
}
