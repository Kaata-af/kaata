import { Link } from "react-router-dom";
import { PhoneMockupHome } from "./PhoneMockups";

export function Hero() {
  return (
    <section className="px-6 pt-16 md:pt-24 pb-20 md:pb-24">
      <div className="max-w-3xl mx-auto text-center">
        <h1 className="text-4xl md:text-6xl font-bold -tracking-[0.02em] leading-[1.05] text-neutral-900">
          Run your shop
          <br />
          on trust.
        </h1>

        <p className="mt-6 text-base md:text-lg text-neutral-600 max-w-xl mx-auto leading-relaxed">
          A quiet ledger between you and the people you trust. Track what they owe you, what you owe
          them, and send a friendly reminder over WhatsApp in two taps.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center items-stretch sm:items-center">
          <Link
            to="/download"
            className="bg-neutral-900 text-white font-semibold px-7 py-3 rounded-lg hover:bg-neutral-800 transition-colors text-sm"
          >
            Download for Android
          </Link>
          <Link
            to="/#how"
            className="text-neutral-600 hover:text-neutral-900 transition-colors px-4 py-3 text-sm font-medium"
          >
            See how it works ↓
          </Link>
        </div>

        <p className="mt-7 text-xs text-neutral-500 font-medium">
          Free forever · Works offline · No account
        </p>
      </div>

      <div className="mt-16 md:mt-20 flex justify-center">
        <PhoneMockupHome />
      </div>
    </section>
  );
}
