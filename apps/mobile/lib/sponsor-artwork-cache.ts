import { Directory, File, Paths } from "expo-file-system";
import { Image, Platform } from "react-native";

const MAX_IMAGE_BYTES = 1_048_576;
const CACHE_NAME = "sponsor-artwork";
const IMAGE_NAME = /^[a-f0-9]{64}\.img$/;
let downloadSequence = 0;

function fileName(path: string): string {
  return `${path.slice(-64)}.img`;
}

function artworkDirectory(): Directory {
  return new Directory(Paths.cache, CACHE_NAME);
}

function usable(file: File): boolean {
  return file.exists && file.size > 0 && file.size <= MAX_IMAGE_BYTES;
}

export function cachedSponsorArtwork(backend: string, path: string): string | null {
  if (Platform.OS === "web") return `${backend}${path}`;
  try {
    const file = new File(artworkDirectory(), fileName(path));
    return usable(file) ? file.uri : null;
  } catch {
    return null;
  }
}

export async function stageSponsorArtwork(
  backend: string,
  paths: readonly string[],
  retained: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (Platform.OS === "web") {
    const results = await Promise.all(
      [...new Set(paths)]
        .filter((path) => !retained.includes(path))
        .map((path) => Image.prefetch(`${backend}${path}`)),
    );
    if (results.includes(false)) throw new Error("sponsor_artwork_unavailable");
    return;
  }
  if (!paths.length && !retained.length) return;
  const directory = artworkDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const keep = new Set([...paths, ...retained].map(fileName));
  for (const file of directory.list()) {
    if (IMAGE_NAME.test(file.name) && !keep.has(file.name)) file.delete();
  }

  // Android can leave a partial file after a cancelled download. Only completed
  // files are moved to their content-addressed names and become visible to Home.
  await Promise.all(
    [...new Set(paths)].map(async (path) => {
      const name = fileName(path);
      const destination = new File(directory, name);
      if (usable(destination)) return;
      const pendingName = `${name}.${Date.now()}-${++downloadSequence}.part`;
      try {
        const pending = new File(directory, pendingName);
        await File.downloadFileAsync(`${backend}${path}`, pending, { signal });
        if (signal.aborted || !usable(pending)) throw new Error("sponsor_artwork_unavailable");
        if (!usable(destination)) pending.moveSync(destination, { overwrite: true });
      } finally {
        const pending = new File(directory, pendingName);
        if (pending.exists) pending.delete();
      }
    }),
  );
}
