import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts as useInter,
} from "@expo-google-fonts/inter";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import {
  Vazirmatn_400Regular,
  Vazirmatn_500Medium,
  Vazirmatn_600SemiBold,
  Vazirmatn_700Bold,
} from "@expo-google-fonts/vazirmatn";

// Vazirmatn for the sans family across the whole app — it supports both
// Latin and Persian glyphs natively, so English UI and Persian UI render in
// one consistent typeface. JetBrains Mono for AFN amounts and timestamps
// everywhere.
//
// Why not Inter for English + Vazirmatn for Persian:
//   The module-load + StyleSheet.create pipeline can't see the user's
//   in-app locale pref synchronously (it lives in app_meta, loaded async).
//   Picking the sans family from device locale at module load means an
//   English-locale device running the app in Dari renders Persian text in
//   Inter — which has no Persian glyphs, so the OS falls back to its
//   default Arabic font (Noto Sans Arabic on Android). That's neither
//   Inter nor Vazirmatn; it's whatever the system ships with.
//
//   We tried locale-aware sans resolution at module load; it failed for
//   exactly that case. The fix is either (a) refactor every StyleSheet
//   site to apply fontFamily inline at render time so a hook can swap
//   families per locale, or (b) just commit to one family that handles
//   both scripts. Vazirmatn's Latin set is reasonable — slightly softer
//   and more humanist than Inter, fine for an Afghan-market app — so
//   we picked (b).
//
// `enRegular` etc. are still exported in case a specific surface ever
// needs Inter (the WhatsApp share text in the device's native client?
// app-store screenshots?), but no code in the app currently uses them.

export const fonts = {
  sansRegular: "Vazirmatn_400Regular",
  sansMedium: "Vazirmatn_500Medium",
  sansSemi: "Vazirmatn_600SemiBold",
  sansBold: "Vazirmatn_700Bold",
  monoRegular: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  monoSemi: "JetBrainsMono_600SemiBold",
  monoBold: "JetBrainsMono_700Bold",
  // Explicit per-script weights kept available for one-off needs. Sans
  // already resolves to Vazirmatn across the board.
  enRegular: "Inter_400Regular",
  enMedium: "Inter_500Medium",
  enSemi: "Inter_600SemiBold",
  enBold: "Inter_700Bold",
  faRegular: "Vazirmatn_400Regular",
  faMedium: "Vazirmatn_500Medium",
  faSemi: "Vazirmatn_600SemiBold",
  faBold: "Vazirmatn_700Bold",
} as const;

export function useAppFonts(): boolean {
  // Tuple is [loaded, error]; callers that only need `loaded` keep the
  // existing boolean signature.
  const [loaded] = useAppFontsWithError();
  return loaded;
}

// D-BOOT-CRASH-DEFENSE: variant that exposes the underlying load error so
// the boot path can show a recovery screen instead of an infinite spinner
// when the font CDN is unreachable on a fresh install.
export function useAppFontsWithError(): readonly [boolean, Error | null] {
  // Load every font we might need so the bundle is self-contained. Inter
  // is kept loaded for the en* keys above; bundle size cost is tiny.
  const [loaded, error] = useInter({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
    JetBrainsMono_700Bold,
    Vazirmatn_400Regular,
    Vazirmatn_500Medium,
    Vazirmatn_600SemiBold,
    Vazirmatn_700Bold,
  });
  return [loaded, error ?? null] as const;
}
