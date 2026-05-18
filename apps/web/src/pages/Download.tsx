import { DownloadButton } from "../components/DownloadButton";

const STEPS = [
  'Tap "Download APK" below.',
  "Open the downloaded file.",
  'If prompted, allow "Install from unknown sources" in settings.',
  "Tap Install.",
];

export function Download() {
  return (
    <main className="px-6 py-16 max-w-2xl mx-auto">
      <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-neutral-900">
        Install Kaata
      </h1>

      <ol className="mt-12 space-y-6">
        {STEPS.map((step, i) => (
          <li key={i} className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gold text-black font-semibold flex items-center justify-center">
              {i + 1}
            </div>
            <p className="pt-1 text-neutral-700 leading-relaxed">{step}</p>
          </li>
        ))}
      </ol>

      <div className="mt-12">
        <DownloadButton />
      </div>

      <p className="mt-6 text-sm text-neutral-500 text-center">Coming soon to Play Store</p>
    </main>
  );
}
