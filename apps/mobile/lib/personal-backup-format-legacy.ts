// Metro resolves the Android file only for Android. This fallback lets iOS
// recognize an old archive without packaging its third-party cipher.
export async function openLegacyBackup(
  _file: Uint8Array,
  _password: string,
): Promise<Uint8Array | null> {
  return null;
}
