import { Link } from "react-router-dom";
import { FeatureSection } from "../components/FeatureSection";
import { Hero } from "../components/Hero";
import {
  PhoneMockupOffline,
  PhoneMockupRestore,
  PhoneMockupWhatsApp,
} from "../components/PhoneMockups";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { useI18n } from "../lib/i18n";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";

export function Home() {
  const { t } = useI18n();
  return (
    <main className="bg-surface">
      <SiteHeader />

      <Hero />

      <div id="how" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          eyebrow={t("feature.offline.eyebrow")}
          title={t("feature.offline.title")}
          body={t("feature.offline.body")}
          mockup={<PhoneMockupOffline />}
          tone="sage"
        />
      </div>

      {/* id="product" — target of the header "Product" / footer "What's
          inside" nav links. */}
      <div id="product" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          reverse
          eyebrow={t("feature.ping.eyebrow")}
          title={t("feature.ping.title")}
          body={t("feature.ping.body")}
          mockup={<PhoneMockupWhatsApp />}
          tone="rose"
        />
      </div>

      {/* Backup/restore — the #1 ask from shopkeeper interviews: the fear of
          losing the whole book with the phone. */}
      <div className="border-t border-neutral-200">
        <FeatureSection
          eyebrow={t("feature.backup.eyebrow")}
          title={t("feature.backup.title")}
          body={t("feature.backup.body")}
          mockup={<PhoneMockupRestore />}
        />
      </div>

      <FinalCTA />

      <SiteFooter />
    </main>
  );
}

function FinalCTA() {
  const { t } = useI18n();
  return (
    <section className="border-t border-neutral-200 px-6 py-20 md:py-28">
      <Card className="max-w-4xl mx-auto rounded-2xl border-surface-balance-border bg-surface-balance px-8 py-16 md:py-20 text-center shadow-none">
        <h2 className="text-3xl md:text-5xl font-bold -tracking-[0.02em] text-brand-primary leading-[1.1]">
          {t("cta.title.line1")}
          <br />
          {t("cta.title.line2")}
        </h2>
        <p className="mt-5 text-base md:text-lg text-muted-foreground max-w-md mx-auto leading-relaxed">
          {t("cta.sub")}
        </p>
        <Button asChild variant="brand" size="lg" className="mt-8 min-h-11">
          <Link to="/download">{t("cta.button")}</Link>
        </Button>
      </Card>
    </section>
  );
}
