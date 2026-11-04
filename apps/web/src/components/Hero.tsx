import { Link } from "react-router-dom";
import { campaignDownloadPath } from "../lib/analytics";
import { useI18n } from "../lib/i18n";
import { PhoneMockupHome } from "./PhoneMockups";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

export function Hero() {
  const { t } = useI18n();
  return (
    <section className="px-6 pt-16 md:pt-24 pb-20 md:pb-24">
      <div className="max-w-3xl mx-auto text-center">
        <Link
          to="/#pricing"
          className="mb-6 inline-flex rounded-full border border-surface-balance-border bg-surface-balance px-4 py-2 text-xs font-medium leading-relaxed text-brand-primary underline-offset-4 hover:underline"
        >
          {t("hero.pricing")}
        </Link>
        <h1 className="text-4xl md:text-6xl font-bold -tracking-[0.02em] leading-[1.1] text-brand-primary">
          {t("hero.title.line1")}
          <br />
          {t("hero.title.line2")}
        </h1>

        <p className="mt-6 text-base md:text-lg text-neutral-600 max-w-xl mx-auto leading-relaxed">
          {t("hero.sub")}
        </p>

        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center items-stretch sm:items-center">
          <Button asChild variant="brand" size="lg" className="min-h-11">
            <Link to={campaignDownloadPath()}>{t("hero.cta")}</Link>
          </Button>
          <Button asChild variant="ghost" size="lg" className="min-h-11">
            <Link to="/#how">{t("hero.how")}</Link>
          </Button>
        </div>
      </div>

      <Card className="mt-12 md:mt-16 mx-auto max-w-5xl flex justify-center rounded-[2rem] border-surface-balance-border bg-surface-balance bg-[radial-gradient(ellipse_at_top_left,#E4EEE6,transparent_60%),radial-gradient(ellipse_at_bottom_right,#F8EAEC,transparent_60%)] py-10 md:py-14 shadow-none">
        <PhoneMockupHome />
      </Card>
    </section>
  );
}
