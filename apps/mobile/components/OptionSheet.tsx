import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { SheetSurface } from "./SheetSurface";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { useSheetDrag } from "../lib/use-sheet-drag";
// OptionSheet — a small single-select picker bottom sheet, extracted from
// preferences.tsx so the kaata-settings screen (which absorbed the old
// Preferences surface) can reuse it for the Language picker. Same chrome as
// BottomSheet.tsx / ProfileSettingsSheet (OFFSCREEN spring-in, BlurView scrim,
// hairline dividers, 220ms exit defer, numeric maxHeight cap).

import { Ionicons } from "@expo/vector-icons";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import {
  SETTINGS_ROW_LABEL_FONT_SIZE,
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_ROW_PADDING_X,
  SETTINGS_ROW_PADDING_Y,
  SETTINGS_SECTION_HEADER_FONT_SIZE,
  SETTINGS_SECTION_HEADER_LETTER_SPACING,
  SETTINGS_SECTION_HEADER_PADDING_BOTTOM,
  SETTINGS_SECTION_HEADER_PADDING_TOP,
  SETTINGS_SHEET_TOP_RADIUS,
} from "../lib/design-tokens";
import { rowDir, textDir, trackingSafe } from "../lib/direction";
import { fonts, monoLineHeight } from "../lib/fonts";
import { icon, typography } from "../lib/tokens";

const SHEET_OFFSCREEN = 600;
// Exit-animation duration. NOTE: unlike BottomSheet, onSelect fires
// immediately on press — the Modal stays mounted for this long afterwards.
// An onSelect that presents native UI (Share sheet, another Modal) must
// defer by this much, or iOS tears the new presentation down when the
// sheet's modal host unmounts (see BottomSheet's deferred-callback note).
export const SHEET_EXIT_MS = 220;

export type OptionSheetItem = { key: string; label: string; leading?: string; hint?: string };

export function OptionSheet(props: {
  visible: boolean;
  title: string;
  options: ReadonlyArray<OptionSheetItem>;
  selected: string;
  onSelect: (key: string) => void;
  onDismiss: () => void;
  isRTL: boolean;
}) {
  const { visible, title, options, selected, onSelect, onDismiss, isRTL } = props;
  const { rendered, opacity, position: translateY } = useOverlayAnimation(visible, SHEET_OFFSCREEN);
  const drag = useSheetDrag(visible, translateY, onDismiss);

  if (!rendered) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={drag.dismiss}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={drag.dismiss} />
      </Animated.View>

      <Animated.View
        style={[styles.sheetContainer, { transform: [{ translateY: drag.translateY }] }]}
        pointerEvents={visible ? "box-none" : "none"}
      >
        <SheetSurface {...drag.surfacePanHandlers} maxHeightRatio={0.75} style={styles.sheetWrap}>
          <View style={styles.sheet}>
            <SheetHandle panHandlers={drag.panHandlers} onDismiss={drag.dismiss} />
            <Text style={[styles.sheetTitle, textDir(isRTL), trackingSafe(isRTL)]}>{title}</Text>
            <ScrollView
              {...drag.scrollProps}
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={{ paddingBottom: 8 }}
            >
              {options.map((o, i) => {
                const isSelected = o.key === selected;
                return (
                  <Pressable
                    key={o.key}
                    onPress={() => onSelect(o.key)}
                    accessibilityRole="button"
                    accessibilityLabel={o.label}
                    accessibilityHint={o.hint}
                    accessibilityState={{ selected: isSelected }}
                    style={({ pressed }) => [
                      styles.sheetRow,
                      rowDir(isRTL),
                      i !== options.length - 1 && styles.sheetRowDivider,
                      pressed && { backgroundColor: colors.bgMuted },
                    ]}
                  >
                    <View style={[styles.sheetRowLeft, rowDir(isRTL)]}>
                      {o.leading ? <Text style={styles.sheetRowLeading}>{o.leading}</Text> : null}
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.sheetRowLabel, textDir(isRTL)]}>{o.label}</Text>
                        {o.hint ? (
                          <Text style={[styles.sheetRowHint, textDir(isRTL)]}>{o.hint}</Text>
                        ) : null}
                      </View>
                    </View>
                    {isSelected ? (
                      // icon.row (22) — the selection tick reads as a row-level
                      // mark, not a trailing chevron, so it takes the row size.
                      // Matches the identical tick in CountryPickerSheet.
                      <Ionicons name="checkmark" size={icon.row} color={colors.actionPrimary} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </SheetSurface>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetContainer: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopRightRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingBottom: 0, flexShrink: 1 },
  sheetTitle: {
    fontSize: SETTINGS_SECTION_HEADER_FONT_SIZE,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: SETTINGS_SECTION_HEADER_PADDING_TOP,
    paddingBottom: SETTINGS_SECTION_HEADER_PADDING_BOTTOM,
    textTransform: "uppercase",
    letterSpacing: SETTINGS_SECTION_HEADER_LETTER_SPACING,
  },
  sheetRow: {
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: SETTINGS_ROW_PADDING_Y,
  },
  sheetRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  sheetRowLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  // Leading glyph column — currency symbols (؋ / $ / Rs) in the vault-settings
  // picker. 18 → 20, the heading step, which is also the size CountryPickerSheet
  // gives the flag in the identical slot; the two pickers are one row design.
  //
  // Only the SIZE comes from typography.heading. The family stays monoSemi
  // because these glyphs are column-aligned inside minWidth 28 and a
  // proportional face breaks that column — and the line height therefore has to
  // be floored at the MONO natural height, not heading's sans one. Spreading
  // heading wholesale would hand a 20px mono glyph a 32px iOS line box and push
  // every currency row ~8px past its 52px minimum.
  sheetRowLeading: {
    fontSize: typography.heading.fontSize,
    fontFamily: fonts.monoSemi,
    lineHeight: monoLineHeight(typography.heading.fontSize, 26),
    color: colors.textEmphasis,
    minWidth: 28,
  },
  sheetRowLabel: {
    fontSize: SETTINGS_ROW_LABEL_FONT_SIZE,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    flexShrink: 1,
  },
  sheetRowHint: {
    ...typography.caption,
    color: colors.textSubtle,
    marginTop: 4,
  },
});
