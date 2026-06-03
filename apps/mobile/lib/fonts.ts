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

// Inter for UI. JetBrains Mono for AFN amounts, phone numbers, timestamps —
// the single typographic decision that does most of the dub.co feel.
// Vazirmatn for Persian / Dari / Arabic UI text — designed specifically for
// Persian-script use, pairs visually with Inter at similar weights. Selected
// by the i18n layer when the active locale uses Arabic script (see lib/i18n).
export const fonts = {
  sansRegular: "Inter_400Regular",
  sansMedium: "Inter_500Medium",
  sansSemi: "Inter_600SemiBold",
  sansBold: "Inter_700Bold",
  monoRegular: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  monoSemi: "JetBrainsMono_600SemiBold",
  monoBold: "JetBrainsMono_700Bold",
  // Persian / Dari / Arabic. Use these as the `fontFamily` when rendering
  // Persian-script content. Inter doesn't include Arabic glyphs at all, so
  // raw text would fall back to system Arabic which looks inconsistent.
  faRegular: "Vazirmatn_400Regular",
  faMedium: "Vazirmatn_500Medium",
  faSemi: "Vazirmatn_600SemiBold",
  faBold: "Vazirmatn_700Bold",
} as const;

export function useAppFonts(): boolean {
  const [loaded] = useInter({
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
  return loaded;
}
