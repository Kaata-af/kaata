import { useEffect, useState } from "react";
import { getLocale, subscribeLocale } from "./i18n";

// Internal direction flag, decoupled from React Native's I18nManager.
//
// Why a separate flag instead of just reading I18nManager.isRTL:
//   1. I18nManager.forceRTL() persists to Android shared prefs AND is
//      process-global — calling it in Expo Go flips Expo Go's own host UI,
//      which the user explicitly does not want.
//   2. I18nManager.isRTL is sealed at Activity creation time. Changing it
//      mid-session has no effect on the current Activity; an Activity
//      recreate is needed, which requires native modules we can't ship to
//      Expo Go.
//   3. We want layout direction to update live when the user picks a new
//      language in Settings, without any kind of restart.
//
// This module owns one boolean — currentDir ∈ {"ltr", "rtl"} — derived from
// the active locale in lib/i18n.ts. Components consume it via useIsRTL(),
// which subscribes to locale changes and re-renders on flip. setLocale() in
// i18n.ts is the single trigger; it notifies our subscribers.
//
// Important: this flag controls only the things WE choose to make
// direction-sensitive (chevron icons today; potentially text alignment,
// margin sides, etc. later). It does NOT cause Yoga to auto-flip any
// flexDirection — that's a separate layer.
//
// Static `flexDirection: "row"` containers (give-button row, FAB anchor,
// swipe rail) stay physically left-to-right because _layout.tsx ensures
// the Activity is LTR (via I18nManager.allowRTL(false) +
// swapLeftAndRightInRTL(false) at module load + a one-shot
// forceRTL(false) migration). If the Activity were RTL, Yoga WOULD
// auto-reverse those containers and the cultural invariants would break
// — exactly the v0.2.4 bug. _layout.tsx's MigrationPrompt prevents the
// app from rendering in an RTL-sealed Activity at all.

export type Direction = "ltr" | "rtl";

function deriveDir(): Direction {
  return getLocale() === "fa" ? "rtl" : "ltr";
}

// Returns the current direction synchronously. Useful for non-React callers
// (formatters, share-message builders) that don't have access to hooks. The
// value mirrors what useIsRTL() returns inside React.
export function getDirection(): Direction {
  return deriveDir();
}

// Hook: returns true when the active locale wants RTL layout. Subscribes to
// locale changes so the consuming component re-renders the moment Settings
// flips the language. Because t() reads currentLocale per render, any
// component that subscribes via this hook also gets fresh translated strings
// for free on the same re-render.
export function useIsRTL(): boolean {
  // Initialize from the current derived direction; useState's lazy form
  // means deriveDir() runs only once on mount.
  const [isRTL, setIsRTL] = useState<boolean>(() => deriveDir() === "rtl");
  useEffect(() => {
    // Recompute on every locale change. We don't trust the notify-time
    // computation — we just re-derive from getLocale() — so subscribers
    // can't drift out of sync with the i18n module.
    return subscribeLocale(() => {
      setIsRTL(deriveDir() === "rtl");
    });
  }, []);
  return isRTL;
}

// Inline style helpers — call from JSX with the result of useIsRTL() to opt
// a container or text node into RTL behavior. Used in array-spread style
// composition: `<View style={[styles.row, rowDir(isRTL)]} />`. Cheap object
// literals; no memoization needed because StyleSheet performs interning at
// the C++ side once values are flattened by RN.

// Flip a row's child order in RTL. Use on header rows, list rows, banners,
// pickers — anywhere a horizontal layout SHOULD mirror in Persian. Skip on
// cultural invariants (give-button row, FAB anchor, swipe rail, tabs pill).
export function rowDir(isRTL: boolean): { flexDirection: "row" | "row-reverse" } {
  return { flexDirection: isRTL ? "row-reverse" : "row" };
}

// Align text to the start edge in the active script. Pair with a Text style
// that doesn't already hardcode textAlign. writingDirection helps RN resolve
// Unicode bidi for mixed-script content (Persian + Latin in one string).
export function textDir(isRTL: boolean): {
  textAlign: "left" | "right";
  writingDirection: "ltr" | "rtl";
} {
  return {
    textAlign: isRTL ? "right" : "left",
    writingDirection: isRTL ? "rtl" : "ltr",
  };
}

/**
 * Cancel letter-spacing when the text is Persian script.
 *
 * Tracking SEVERS Arabic-script joining: Persian letters connect into words,
 * and any non-zero letterSpacing renders them as disconnected glyphs. It is not
 * a subtle typographic degradation — it is the difference between text a Dari
 * shopkeeper reads at a glance and text they have to decode letter by letter.
 *
 * Append to the END of a style array so it wins over the base style:
 *
 *     style={[styles.sectionHeader, trackingSafe(isRTL)]}
 *
 * Latin tracking is preserved (returns null in LTR), so the English look is
 * unchanged. The same fix exists in the web app's wordmark and in the export
 * PDF's headers; components/Chip.tsx was the first place it landed here.
 *
 * Do NOT apply this to text that is always Latin regardless of locale —
 * formatted amounts go through lib/format.ts, which hardcodes
 * toLocaleString("en-US"), so those keep their tracking in both languages.
 */
export function trackingSafe(isRTL: boolean): { letterSpacing: 0 } | null {
  return isRTL ? { letterSpacing: 0 } : null;
}

// Wrap a value in Unicode FSI…PDI so it keeps its OWN base direction when
// interpolated into a sentence in the other script. Without it, a Latin
// filename inside a forced-RTL line has its trailing "…-2026-08-07.pdf"
// reordered — the date and extension jump to the wrong end. Use for any
// machine-shaped value (file names, phone numbers, URLs, ids) rendered
// inside translated copy.
export function bidiIsolate(value: string): string {
  return `⁨${value}⁩`;
}
