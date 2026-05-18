import { DownloadButton } from "../components/DownloadButton";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

const STEPS = [
  'Tap "Download APK" below.',
  "Open the downloaded file.",
  'If prompted, allow "Install from unknown sources" in settings.',
  "Tap Install.",
];

export function Download() {
  return (
    <main>
      <SiteHeader />

      <section className="px-6 py-16 md:py-20 max-w-2xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-neutral-900">
          Install Kaata
        </h1>
        <p className="mt-4 text-base text-neutral-600 leading-relaxed">
          Side-load the APK directly. Coming soon to the Play Store.
        </p>

        <ol className="mt-10 space-y-5">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-4 items-start">
              <div className="flex-shrink-0 w-7 h-7 rounded-full border border-neutral-300 bg-white text-neutral-700 font-semibold flex items-center justify-center text-xs font-mono mt-0.5">
                {i + 1}
              </div>
              <p className="pt-0.5 text-neutral-700 leading-relaxed">{step}</p>
            </li>
          ))}
        </ol>

        <div className="mt-12">
          <DownloadButton />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
