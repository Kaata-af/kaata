import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { WHATSAPP_CONTACT_URL } from "../env";
import { useI18n } from "../lib/i18n";

// Header mirrors dub.co's chassis: logo at the start, nav links centered,
// primary CTA at the end (start/end flip with the document direction for
// Persian). Border and backdrop blur are absent at the top of the page and
// fade in once the user starts scrolling.
export function SiteHeader() {
  const scrolled = useScrolled(8);
  const { t, lang, setLang } = useI18n();

  return (
    <header
      className={`sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-200 border-b ${
        scrolled
          ? "bg-white/70 backdrop-blur-xl border-neutral-200/60"
          : "bg-transparent border-transparent"
      }`}
    >
      {/* Flex on mobile (logo + actions hug the edges), grid on desktop so
          the nav stays perfectly centered between the two. */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex md:grid md:grid-cols-[1fr_auto_1fr] items-center justify-between">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 md:justify-self-start">
          <img src="/logo.png" alt="" className="w-6 h-6" />
          {/* Persian wordmark (کاتا.) drops tracking-tight — negative
              letter-spacing breaks Arabic-script joining. */}
          <span
            className={`text-base font-bold text-neutral-900 ${lang === "fa" ? "" : "tracking-tight"}`}
          >
            {t("brand.wordmark")}
          </span>
        </Link>

        {/* Center nav (desktop only) */}
        <nav className="hidden md:flex md:justify-self-center items-center gap-7 text-[13px]">
          <Link
            to="/#product"
            className="text-neutral-600 hover:text-neutral-900 font-medium transition-colors"
          >
            {t("nav.product")}
          </Link>
          <Link
            to="/#how"
            className="text-neutral-600 hover:text-neutral-900 font-medium transition-colors"
          >
            {t("nav.how")}
          </Link>
          <Link
            to="/download"
            className="text-neutral-600 hover:text-neutral-900 font-medium transition-colors"
          >
            {t("nav.download")}
          </Link>
        </nav>

        <div className="flex items-center gap-2 md:justify-self-end">
          {/* Language toggle — shows the language you'd switch TO. Persian
              is the audience's language; one tap from either side. */}
          <button
            type="button"
            onClick={() => setLang(lang === "fa" ? "en" : "fa")}
            lang={lang === "fa" ? "en" : "fa"}
            className="text-[13px] font-medium text-neutral-600 hover:text-neutral-900 px-2.5 h-8 inline-flex items-center rounded-lg hover:bg-neutral-100 transition-colors"
          >
            {lang === "fa" ? "English" : "دری"}
          </button>

          {/* Primary CTA. Dub's signature interaction: ring on hover. */}
          <Link
            to="/download"
            className="bg-neutral-900 text-white font-medium px-3.5 h-8 inline-flex items-center rounded-lg ring-0 ring-neutral-100 hover:ring-4 transition-[box-shadow] text-[13px]"
          >
            {t("nav.getApp")}
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
  const { t, lang } = useI18n();
  return (
    <footer className="border-t border-neutral-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-16 grid md:grid-cols-3 gap-12 md:gap-6">
        <div>
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.png" alt="" className="w-7 h-7" />
            <span
              className={`text-lg font-bold text-neutral-900 ${lang === "fa" ? "" : "tracking-tight"}`}
            >
              {t("brand.wordmark")}
            </span>
          </Link>
          <p className="mt-4 text-sm text-neutral-500 max-w-xs leading-relaxed">
            {t("footer.tagline")}
          </p>
        </div>

        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-900">
            {t("footer.product")}
          </h3>
          <ul className="mt-4 space-y-2.5 text-sm text-neutral-500">
            <li>
              <Link to="/download" className="hover:text-neutral-900 transition-colors">
                {t("footer.download")}
              </Link>
            </li>
            <li>
              <Link to="/#how" className="hover:text-neutral-900 transition-colors">
                {t("footer.how")}
              </Link>
            </li>
            <li>
              <Link to="/#product" className="hover:text-neutral-900 transition-colors">
                {t("footer.inside")}
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-900">
            {t("footer.company")}
          </h3>
          <ul className="mt-4 space-y-2.5 text-sm text-neutral-500">
            <li>
              <a
                href={WHATSAPP_CONTACT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-neutral-900 transition-colors"
              >
                {t("footer.contact")}
              </a>
            </li>
            <li>
              <Link to="/privacy" className="hover:text-neutral-900 transition-colors">
                {t("footer.privacy")}
              </Link>
            </li>
            <li>
              <Link to="/terms" className="hover:text-neutral-900 transition-colors">
                {t("footer.terms")}
              </Link>
            </li>
            <li>
              <Link to="/delete-account" className="hover:text-neutral-900 transition-colors">
                {t("footer.deleteAccount")}
              </Link>
            </li>
            <li>
              <span>{t("footer.openSource")}</span>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-neutral-200">
        <div className="max-w-6xl mx-auto px-6 py-5 text-xs text-neutral-500">
          {t("footer.copyright")}
        </div>
      </div>
    </footer>
  );
}
