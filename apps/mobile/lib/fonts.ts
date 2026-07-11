import { Platform } from "react-native";
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

// ---------------------------------------------------------------------------
// Line heights — the iOS clipping invariant.
//
// Measured from the bundled TTFs (hhea ascent/descent; identical across
// weights):
//   Vazirmatn:      ascent 2100, descent -1100, upem 2048 → 1.5625em natural
//   JetBrains Mono: ascent 1020, descent  -300, upem 1000 → 1.32em natural
//
// Vazirmatn's metrics are huge because they reserve headroom for Persian
// ascenders + stacked diacritics — and they apply to EVERY string, English
// included (the glyph box belongs to the font file, not the script).
//
// The two platforms resolve a lineHeight SMALLER than the font's natural
// height in opposite ways:
//   - Android: includeFontPadding:false trims the font's padding, so tight
//     line boxes fit. This is why all our tight values look right there.
//   - iOS: no trim exists. The glyph run keeps its descent and overflows the
//     top of the reduced line box, and the overflow is CLIPPED — English
//     capitals lose their heads, Dari marks vanish. (First observed on the
//     home header: fontSize 28 / lineHeight 32 vs a 43.75px natural height.)
//
// INVARIANT: never give a Text a raw lineHeight below its font's natural
// height on iOS. Route every sans/mono lineHeight through these helpers:
// Android keeps the designed tight value verbatim, iOS is floored at the
// font's natural height. (System-font text — no fontFamily — is exempt;
// SF/Roboto metrics are ~1.2em and our ratios clear them.)
export const SANS_NATURAL_EM = 1.5625; // Vazirmatn
export const MONO_NATURAL_EM = 1.32; // JetBrains Mono

function flooredLineHeight(fontSize: number, tight: number, naturalEm: number): number {
  if (Platform.OS !== "ios") return tight;
  return Math.max(tight, Math.ceil(fontSize * naturalEm));
}

export function sansLineHeight(fontSize: number, tight: number): number {
  return flooredLineHeight(fontSize, tight, SANS_NATURAL_EM);
}

export function monoLineHeight(fontSize: number, tight: number): number {
  return flooredLineHeight(fontSize, tight, MONO_NATURAL_EM);
}

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
