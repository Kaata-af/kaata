import { Link } from "react-router-dom";
import { FeatureSection } from "../components/FeatureSection";
import { Hero } from "../components/Hero";
import { PhoneMockupOffline, PhoneMockupWhatsApp } from "../components/PhoneMockups";

const WHATSAPP_URL = "https://wa.me/93781696644";

export function Home() {
  return (
    <main>
      <Hero />

      <div id="how" className="border-t border-neutral-200">
        <FeatureSection
          eyebrow="WhatsApp, two taps"
          title="Send a reminder. Make it official."
          body="Tap a customer, tap Send. Kaata opens WhatsApp with a polite, pre-filled message — their name, your shop, their current balance. No copy-paste, no awkward typing. Just a friendly reminder, sent in seconds."
          mockup={<PhoneMockupWhatsApp />}
        />
      </div>

      <div className="border-t border-neutral-200">
        <FeatureSection
          reverse
          eyebrow="Built for the bazaar"
          title="Works offline."
          body="Your kaata book lives on your phone. Add customers, record debts and payments, send reminders — all without a connection. Kaata only goes online to check for updates. Your data stays where it belongs."
          mockup={<PhoneMockupOffline />}
        />
      </div>

      <section className="border-t border-neutral-200 px-6 py-28 md:py-36 text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05] text-neutral-900">
            Stop chasing slips
            <br />
            of paper.
          </h2>
          <p className="mt-8 text-lg text-neutral-600 leading-relaxed">
            Free forever. No account, no card, no setup.
          </p>
          <Link
            to="/download"
            className="mt-10 inline-block bg-neutral-900 text-white font-semibold px-10 py-4 rounded-md hover:bg-neutral-800 transition-colors text-base"
          >
            Download for Android
          </Link>
        </div>
      </section>

      <footer className="border-t border-neutral-200">
        <div className="max-w-6xl mx-auto px-6 py-12 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 text-sm text-neutral-500">
          <div>
            <p className="text-neutral-900 font-semibold tracking-tight">
              Kaata<span className="text-gold">.</span>
            </p>
            <p className="mt-1">Built in Kabul. © 2026.</p>
          </div>
          <nav className="flex gap-8">
            <Link to="/download" className="hover:text-neutral-900 transition-colors">
              Download
            </Link>
            <a href="#how" className="hover:text-neutral-900 transition-colors">
              How it works
            </a>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-neutral-900 transition-colors"
            >
              Contact
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
