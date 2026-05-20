import { Link } from "react-router-dom";
import { FeatureSection } from "../components/FeatureSection";
import { Hero } from "../components/Hero";
import { PhoneMockupOffline, PhoneMockupWhatsApp } from "../components/PhoneMockups";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

export function Home() {
  return (
    <main>
      <SiteHeader />

      <Hero />

      <div id="how" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          eyebrow="Built for the bazaar"
          title="A quiet tally that works offline."
          body="Your kaata book lives on your phone. Add people, record what you gave and what you received — all without a connection. No account, no cloud, no setup. Your data stays where it belongs."
          mockup={<PhoneMockupOffline />}
        />
      </div>

      <div className="border-t border-neutral-200">
        <FeatureSection
          reverse
          eyebrow="The killer feature"
          title="A reminder, two taps away."
          body="Open a person, tap Ping. Kaata opens WhatsApp with a polite, pre-filled message — their name, your shop, their current balance. No copy-paste, no awkward typing. Just a friendly nudge, sent in seconds."
          mockup={<PhoneMockupWhatsApp />}
        />
      </div>

      <FinalCTA />

      <SiteFooter />
    </main>
  );
}

function FinalCTA() {
  return (
    <section className="border-t border-neutral-200 px-6 py-20 md:py-28">
      <div className="max-w-4xl mx-auto rounded-2xl border border-neutral-200 bg-neutral-50 px-8 py-16 md:py-20 text-center">
        <h2 className="text-3xl md:text-5xl font-bold -tracking-[0.02em] text-neutral-900 leading-[1.05]">
          Stop chasing slips
          <br />
          of paper.
        </h2>
        <p className="mt-5 text-base md:text-lg text-neutral-600 max-w-md mx-auto leading-relaxed">
          Free forever. No account, no card, no setup.
        </p>
        <Link
          to="/download"
          className="mt-8 inline-block bg-neutral-900 text-white font-semibold px-8 py-3.5 rounded-lg hover:bg-neutral-800 transition-colors text-sm"
        >
          Download for Android
        </Link>
      </div>
    </section>
  );
}
