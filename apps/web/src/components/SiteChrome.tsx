import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { WHATSAPP_CONTACT_URL } from "../env";

// Header mirrors dub.co's chassis: logo left, nav links centered, primary
// CTA far right. Border and backdrop blur are absent at the top of the page
// and fade in once the user starts scrolling — same progressive treatment
// dub uses.
export function SiteHeader() {
  const scrolled = useScrolled(8);

  return (
    <header
      className={`sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-200 border-b ${
        scrolled
          ? "bg-white/70 backdrop-blur-xl border-neutral-200/60"
          : "bg-transparent border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-14 grid grid-cols-[1fr_auto_1fr] items-center">
        {/* Left: logo */}
        <Link to="/" className="flex items-center gap-2 justify-self-start">
          <img src="/logo.png" alt="" className="w-6 h-6" />
          <span className="text-base font-bold tracking-tight text-neutral-900">kaata.</span>
        </Link>

        {/* Center: nav links */}
        <nav className="hidden md:flex items-center gap-7 justify-self-center text-[13px]">
          <Link
            to="/#product"
            className="text-neutral-600 hover:text-neutral-900 font-medium transition-colors"
          >
            Product
          </Link>
          <Link
            to="/#how"
            className="text-neutral-600 hover:text-neutral-900 font-medium transition-colors"
          >
            How it works
          </Link>
          <Link
            to="/download"
            className="text-neutral-600 hover:text-neutral-900 font-medium transition-colors"
          >
            Download
          </Link>
        </nav>

        {/* Right: primary CTA. Dub's signature interaction: ring on hover, not darken. */}
        <div className="justify-self-end">
          <Link
            to="/download"
            className="bg-neutral-900 text-white font-medium px-3.5 h-8 inline-flex items-center rounded-lg ring-0 ring-neutral-100 hover:ring-4 transition-[box-shadow] text-[13px]"
          >
            Get the app
          </Link>
        </div>
      </div>
    </header>
  );
}

function useScrolled(threshold: number): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

export function SiteFooter() {
  return (
    <footer className="border-t border-neutral-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-16 grid md:grid-cols-3 gap-12 md:gap-6">
        <div>
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.png" alt="" className="w-7 h-7" />
            <span className="text-lg font-bold tracking-tight text-neutral-900">kaata.</span>
          </Link>
          <p className="mt-4 text-sm text-neutral-500 max-w-xs leading-relaxed">
            A quiet ledger between you and the people you trust. Built in Kabul.
          </p>
        </div>

        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-900">
            Product
          </h3>
          <ul className="mt-4 space-y-2.5 text-sm text-neutral-500">
            <li>
              <Link to="/download" className="hover:text-neutral-900 transition-colors">
                Download
              </Link>
            </li>
            <li>
              <Link to="/#how" className="hover:text-neutral-900 transition-colors">
                How it works
              </Link>
            </li>
            <li>
              <Link to="/#product" className="hover:text-neutral-900 transition-colors">
                What&apos;s inside
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-900">
            Company
          </h3>
          <ul className="mt-4 space-y-2.5 text-sm text-neutral-500">
            <li>
              <a
                href={WHATSAPP_CONTACT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-neutral-900 transition-colors"
              >
                Contact on WhatsApp
              </a>
            </li>
            <li>
              <span>Open source · Coming soon</span>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-neutral-200">
        <div className="max-w-6xl mx-auto px-6 py-5 text-xs text-neutral-500">
          © 2026 Kaata · Made in Kabul.
        </div>
      </div>
    </footer>
  );
}
