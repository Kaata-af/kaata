import Link from "next/link";
import { PhoneMockupHome } from "./PhoneMockups";

export function Hero() {
  return (
    <section className="relative px-6 pt-28 md:pt-36 pb-20 md:pb-24 overflow-hidden">
      {/* Subtle warm wash behind the headline */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[700px] -z-10"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(196,154,60,0.16), transparent 70%)",
        }}
      />

      <div className="max-w-3xl mx-auto text-center">
        <p className="inline-flex items-center gap-2 text-[11px] font-medium tracking-wider uppercase text-[#7a5f1f] bg-gold/10 border border-gold/30 rounded-full px-3 py-1 mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-gold" />
          Free forever
        </p>

        <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[1.02] text-neutral-900">
          Run your shop
          <br />
          <span className="text-gold">on trust.</span>
        </h1>

        <p className="mt-8 text-lg md:text-xl text-neutral-600 max-w-xl mx-auto leading-relaxed">
          Kaata replaces the paper notebook with a digital ledger that lives in your pocket. Track
          every customer, every debt, every payment — offline, on your phone.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center items-stretch sm:items-center">
          <Link
            href="/download"
            className="bg-neutral-900 text-white font-semibold px-8 py-3.5 rounded-md hover:bg-neutral-800 transition-colors text-base"
          >
            Download for Android
          </Link>
          <Link
            href="#how"
            className="text-neutral-600 hover:text-neutral-900 transition-colors px-4 py-3.5 text-base"
          >
            See how it works ↓
          </Link>
        </div>
      </div>

      <div className="mt-20 md:mt-24 flex justify-center">
        <PhoneMockupHome />
      </div>
    </section>
  );
}
