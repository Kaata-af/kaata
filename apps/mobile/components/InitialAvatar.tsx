// InitialAvatar — the letter-in-circle identity chip (home-header profile
// button, settings-sheet identity row). One shared implementation because
// centering a single letter in a circle is NOT the default Text layout in
// this app's font stack, and both prior call sites had drifted into the same
// visibly-off rendering (letter above center; worse on iOS).
//
// Why a bare centered <Text> is off-center in Vazirmatn: the font's vertical
// metrics are deliberately lopsided — hhea ascent 2100 vs descent -1100 at
// upem 2048 (measured; see lib/fonts.ts) — because they reserve headroom for
// Persian stacked diacritics. The line box's midpoint therefore sits at
// baseline + (ascent-descent)/2 ≈ baseline + 0.24em, while the letters
// actually drawn in an initial chip (Latin caps ≈ 0.72em tall, Persian
// initial forms mostly a 0.5–0.65em band above the baseline) have their
// visual centers around baseline + 0.28–0.36em. Centering the LINE BOX in
// the circle thus paints the LETTER ~0.04–0.12em above true center — about
// 1.5px at chip sizes, which reads as a lopsided chip.
//
// The correction:
//   - includeFontPadding:false — Android otherwise adds its own asymmetric
//     font padding on top of the metrics, so the two platforms wouldn't
//     even agree on the box being corrected.
//   - explicit lineHeight at the font's NATURAL height on BOTH platforms
//     (not just the iOS floor) so the box is identical cross-platform and
//     the clipping invariant in lib/fonts.ts holds.
//   - a small DOWNWARD optical nudge of 0.08em — the midpoint of the
//     0.04–0.12em error band above, splitting the difference between Latin
//     caps and Persian initials so neither script reads tilted.
//   - textAlign:center over the full chip width for exact horizontal
//     centering regardless of glyph side bearings.
//
// allowFontScaling is off: the circle is a fixed-size chrome element; OS
// accessibility scaling would overflow the glyph out of the circle (the
// header's read-only badge sets the same precedent).

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { colors } from "../lib/colors";
import { fonts, SANS_NATURAL_EM } from "../lib/fonts";

// Letter size relative to the circle diameter. 0.44 keeps a comfortable ring
// of background around the glyph at every size in use (36 header, 44 hero).
const LETTER_EM_OF_SIZE = 0.44;
// Downward optical correction, in em of the letter size — see header comment.
const OPTICAL_NUDGE_EM = 0.08;

export function InitialAvatar(props: {
  /** The (single-grapheme) letter to render. */
  label: string;
  /** Circle diameter in px. */
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { label, size, style } = props;
  const fontSize = Math.round(size * LETTER_EM_OF_SIZE);
  const lineHeight = Math.ceil(fontSize * SANS_NATURAL_EM);
  // Half-px precision: enough to land on a device pixel at 2x/3x densities.
  const nudge = Math.round(fontSize * OPTICAL_NUDGE_EM * 2) / 2;
  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }, style]}>
      <Text
        allowFontScaling={false}
        style={[styles.letter, { fontSize, lineHeight, transform: [{ translateY: nudge }] }]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    textAlign: "center",
    width: "100%",
    includeFontPadding: false,
  },
});
