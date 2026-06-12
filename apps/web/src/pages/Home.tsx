import { Link } from "react-router-dom";
import { FeatureSection } from "../components/FeatureSection";
import { Hero } from "../components/Hero";
import { PhoneMockupOffline, PhoneMockupWhatsApp } from "../components/PhoneMockups";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { useI18n } from "../lib/i18n";

export function Home() {
  const { t } = useI18n();
  return (
    <main>
      <SiteHeader />

      <Hero />

      <div id="how" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          eyebrow={t("feature.offline.eyebrow")}
          title={t("feature.offline.title")}
          body={t("feature.offline.body")}
          mockup={<PhoneMockupOffline />}
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
      <div className="max-w-4xl mx-auto rounded-2xl border border-neutral-200 bg-neutral-50 px-8 py-16 md:py-20 text-center">
        <h2 className="text-3xl md:text-5xl font-bold -tracking-[0.02em] text-neutral-900 leading-[1.1]">
          {t("cta.title.line1")}
          <br />
          {t("cta.title.line2")}
        </h2>
        <p className="mt-5 text-base md:text-lg text-neutral-600 max-w-md mx-auto leading-relaxed">
          {t("cta.sub")}
        </p>
        <Link
          to="/download"
          className="mt-8 inline-block bg-neutral-900 text-white font-semibold px-8 py-3.5 rounded-lg hover:bg-neutral-800 transition-colors text-sm"
        >
          {t("cta.button")}
        </Link>
      </div>
    </section>
  );
}
