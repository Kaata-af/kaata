export function DownloadButton({ version = "0.1.0" }: { version?: string }) {
  return (
    <a
      href={`/downloads/kaata-${version}.apk`}
      className="block w-full bg-neutral-900 text-white font-semibold px-8 py-5 rounded-md hover:bg-neutral-800 transition-colors text-center text-lg"
    >
      Download APK (v{version})
    </a>
  );
}
