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

      <BuildingBlocks />

      <div id="how" className="border-t border-neutral-200 scroll-mt-16">
        <FeatureSection
          eyebrow="The killer feature"
          title="A reminder, two taps away."
          body="Open a person, tap Ping. Kaata opens WhatsApp with a polite, pre-filled message — their name, your shop, their current balance. No copy-paste, no awkward typing. Just a friendly nudge, sent in seconds."
          mockup={<PhoneMockupWhatsApp />}
        />
      </div>

      <div className="border-t border-neutral-200">
        <FeatureSection
          reverse
          eyebrow="Built for the bazaar"
          title="Works offline."
          body="Your kaata book lives on your phone. Add people, record what you gave and what you received, send reminders — all without a connection. The only network call is checking for updates. Your data stays where it belongs."
          mockup={<PhoneMockupOffline />}
        />
      </div>

      <FinalCTA />

      <SiteFooter />
    </main>
  );
}

// "Specimen sheet" — shows the actual atoms of the product (a row, a chip,
// a message). Quiet-fintech sites lean on this pattern (Linear, Mercury, Ramp)
// so visitors *see* the design vocabulary instead of just reading about it.
function BuildingBlocks() {
  return (
    <section id="product" className="border-t border-neutral-200 px-6 py-20 md:py-28 scroll-mt-16">
      <div className="max-w-6xl mx-auto">
        <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500">
          The building blocks
        </p>
        <h2 className="mt-3 text-3xl md:text-5xl font-bold -tracking-[0.02em] text-neutral-900 leading-tight max-w-2xl">
          A quiet ledger,
          <br />
          built piece by piece.
        </h2>

        <div className="mt-12 md:mt-16 grid md:grid-cols-3 gap-6 md:gap-8">
          {/* Fragment 1: a person row */}
          <div>
            <div className="rounded-xl border border-neutral-200 bg-white p-5 min-h-[200px] flex items-center">
              <div className="w-full flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-neutral-900">Mahmood</p>
                  <p className="text-xs text-neutral-500 mt-0.5">2d ago</p>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-sm font-semibold font-mono text-neutral-900">3,800</span>
                  <span className="text-[10px] font-medium text-neutral-400">AFN</span>
                </div>
              </div>
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              A person
            </p>
            <p className="mt-1.5 text-sm text-neutral-600 leading-relaxed">
              Just a name and what they owe you. Saved on your phone, nowhere else.
            </p>
          </div>

          {/* Fragment 2: chip + balance */}
          <div>
            <div className="rounded-xl border border-neutral-200 bg-white p-5 min-h-[200px] flex flex-col justify-center">
              <div className="inline-flex self-start items-center px-2 py-0.5 rounded-md bg-collect-bg">
                <span className="text-[10px] font-semibold tracking-wider text-collect-text uppercase">
                  They owe you
                </span>
              </div>
              <div className="flex items-baseline gap-1.5 mt-3">
                <span className="text-4xl font-bold font-mono text-neutral-900 -tracking-[0.03em] leading-none">
                  1,250
                </span>
                <span className="text-sm font-medium text-neutral-400">AFN</span>
              </div>
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              A direction
            </p>
            <p className="mt-1.5 text-sm text-neutral-600 leading-relaxed">
              Owed to you, or owed to them. The chip says which. The number stays calm.
            </p>
          </div>

          {/* Fragment 3: the actual WhatsApp message */}
          <div>
            <div className="rounded-xl border border-neutral-200 bg-[#efeae2] p-4 min-h-[200px] flex items-center">
              <div className="bg-[#d9fdd3] rounded-2xl rounded-br-sm px-3 py-2.5 text-[12px] text-neutral-900 leading-relaxed shadow-[0_1px_0_rgba(0,0,0,0.04)]">
                Salaam Ahmad.
                <br />
                <br />
                Your kaata at Shop Sultan:
                <br />
                🔴 You owe: <span className="font-mono font-semibold">−1,250 AFN</span>
                <br />
                <br />
                Please settle when you can.
                <br />
                <br />
                <span className="text-neutral-500">— Sent via Kaata.af</span>
              </div>
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              A reminder
            </p>
            <p className="mt-1.5 text-sm text-neutral-600 leading-relaxed">
              Polite, short, signed. The exact message that arrives on their phone.
            </p>
          </div>
        </div>
      </div>
    </section>
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
