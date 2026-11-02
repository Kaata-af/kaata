import { useEffect, useRef, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { FeatureSection } from "../components/FeatureSection";
import { Hero } from "../components/Hero";
import { PhoneMockupBill } from "../components/BillMockups";
import { PhoneMockupBusinesses } from "../components/BusinessMockup";
import { PhoneMockupMembers } from "../components/MemberMockups";
import { ProductComparison } from "../components/ProductComparison";
import { Pricing } from "../components/Pricing";
import {
  PhoneMockupOffline,
  PhoneMockupNotifications,
  PhoneMockupRestore,
  PhoneMockupShared,
  PhoneMockupWhatsApp,
} from "../components/PhoneMockups";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { useI18n } from "../lib/i18n";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { getWebSession, WEB_SESSION_EVENT } from "../lib/web-auth";
import { WEB_ROUTES } from "../lib/web-routes";

function subscribeToSessionChange(changed: () => void) {
  window.addEventListener(WEB_SESSION_EVENT, changed);
  window.addEventListener("focus", changed);
  window.addEventListener("pageshow", changed);
  return () => {
    window.removeEventListener(WEB_SESSION_EVENT, changed);
    window.removeEventListener("focus", changed);
    window.removeEventListener("pageshow", changed);
  };
}

const hasWebSession = () => !!getWebSession();
const noServerSession = () => false;

export function Home() {
  const { t, lang } = useI18n();
  const signedIn = useSyncExternalStore(subscribeToSessionChange, hasWebSession, noServerSession);
  const redirected = useRef(false);
  useEffect(() => {
    if (!signedIn || redirected.current) return;
    redirected.current = true;
    // Load the private app document's CSP, cache and referrer headers. A
    // client-only route change would retain the public landing page's CSP.
    window.location.replace(WEB_ROUTES.workspace);
  }, [signedIn]);

  if (signedIn)
    return (
      <main
        className="flex min-h-dvh items-center justify-center bg-neutral-50 text-sm text-neutral-500"
        role="status"
      >
        {lang === "fa"
          ? "کاتا باز می‌شود…"
          : lang === "ps"
            ? "کاتا پرانیستل کېږي…"
            : "Opening Kaata…"}
      </main>
    );

  return (
    <main className="bg-surface">
      <SiteHeader />

      <Hero />

      <Pricing />

      <div id="product" className="scroll-mt-16">
        <div id="backup" className="border-t border-neutral-200 scroll-mt-16">
          <FeatureSection
            eyebrow={t("feature.backup.eyebrow")}
            title={t("feature.backup.title")}
            body={t("feature.backup.body")}
            mockup={<PhoneMockupRestore />}
            tone="sage"
          />
        </div>
      </div>

      <div id="businesses" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          reverse
          eyebrow={t("feature.businesses.eyebrow")}
          title={t("feature.businesses.title")}
          body={t("feature.businesses.body")}
          highlights={[
            t("feature.businesses.point1"),
            t("feature.businesses.point2"),
            t("feature.businesses.point3"),
          ]}
          mockup={<PhoneMockupBusinesses />}
        />
      </div>

      <div id="members" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          wide
          eyebrow={t("feature.members.eyebrow")}
          title={t("feature.members.title")}
          body={t("feature.members.body")}
          highlights={[
            t("feature.members.point1"),
            t("feature.members.point2"),
            t("feature.members.point3"),
          ]}
          mockup={<PhoneMockupMembers />}
        />
      </div>

      <div id="how" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          eyebrow={t("feature.offline.eyebrow")}
          title={t("feature.offline.title")}
          body={t("feature.offline.body")}
          mockup={<PhoneMockupOffline />}
          tone="sage"
        />
      </div>

      <div id="shared" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          reverse
          eyebrow={t("feature.shared.eyebrow")}
          title={t("feature.shared.title")}
          body={t("feature.shared.body")}
          highlights={[
            t("feature.shared.point1"),
            t("feature.shared.point2"),
            t("feature.shared.point3"),
          ]}
          mockup={<PhoneMockupShared />}
        />
      </div>

      <div id="notifications" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          eyebrow={t("feature.notifications.eyebrow")}
          title={t("feature.notifications.title")}
          body={t("feature.notifications.body")}
          highlights={[
            t("feature.notifications.point1"),
            t("feature.notifications.point2"),
            t("feature.notifications.point3"),
          ]}
          mockup={<PhoneMockupNotifications />}
          tone="sage"
        />
      </div>

      <div id="bills" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          wide
          eyebrow={t("feature.bills.eyebrow")}
          title={t("feature.bills.title")}
          body={t("feature.bills.body")}
          highlights={[
            t("feature.bills.point1"),
            t("feature.bills.point2"),
            t("feature.bills.point3"),
          ]}
          mockup={<PhoneMockupBill />}
        />
      </div>

      <div id="reminders" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          eyebrow={t("feature.ping.eyebrow")}
          title={t("feature.ping.title")}
          body={t("feature.ping.body")}
          mockup={<PhoneMockupWhatsApp />}
          tone="rose"
        />
      </div>

      <ProductExtras />

      <ProductComparison />

      <FinalCTA />

      <SiteFooter />
    </main>
  );
}

function ProductExtras() {
  const { t } = useI18n();
  const features = [
    {
      title: t("extras.currencies.title"),
      body: t("extras.currencies.body"),
      path: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6v12m3-10h-4.5a2.5 2.5 0 0 0 0 5h3a2.5 2.5 0 0 1 0 5H9",
    },
    {
      title: t("extras.search.title"),
      body: t("extras.search.body"),
      path: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6",
    },
    {
      title: t("extras.reminders.title"),
      body: t("extras.reminders.body"),
      path: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2",
    },
    {
      title: t("extras.lock.title"),
      body: t("extras.lock.body"),
      path: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm7 4v2",
    },
  ];
  return (
    <section id="more-features" className="border-t border-neutral-200 px-6 py-20 md:py-24">
      <div className="mx-auto max-w-6xl">
        <p className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          {t("extras.eyebrow")}
        </p>
        <h2 className="max-w-2xl text-3xl font-bold leading-tight tracking-tight text-neutral-900 md:text-4xl">
          {t("extras.title")}
        </h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <div key={feature.title} className="min-w-0 border-t border-neutral-200 pt-5">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="mb-4 h-6 w-6 text-neutral-700"
              >
                <path d={feature.path} />
              </svg>
              <h3 className="text-base font-semibold leading-snug text-neutral-900">
                {feature.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-neutral-600">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
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
