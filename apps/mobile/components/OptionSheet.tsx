// OptionSheet — a small single-select picker bottom sheet, extracted from
// preferences.tsx so the kaata-settings screen (which absorbed the old
// Preferences surface) can reuse it for the Language picker. Same chrome as
// BottomSheet.tsx / ProfileSettingsSheet (OFFSCREEN spring-in, BlurView scrim,
// hairline dividers, 220ms exit defer, numeric maxHeight cap).

import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SHEET_BLUR_METHOD } from "../lib/blur";
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
import { rowDir, textDir } from "../lib/direction";
import { fonts } from "../lib/fonts";

const SHEET_OFFSCREEN = 600;
// Exit-animation duration. NOTE: unlike BottomSheet, onSelect fires
// immediately on press — the Modal stays mounted for this long afterwards.
// An onSelect that presents native UI (Share sheet, another Modal) must
// defer by this much, or iOS tears the new presentation down when the
// sheet's modal host unmounts (see BottomSheet's deferred-callback note).
export const SHEET_EXIT_MS = 220;

export type OptionSheetItem = { key: string; label: string; leading?: string };

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
  const [rendered, setRendered] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(SHEET_OFFSCREEN)).current;

  useEffect(() => {
    if (visible) {
      setRendered(true);
      requestAnimationFrame(() => {
        Animated.parallel([
          Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            friction: 11,
            tension: 75,
          }),
        ]).start();
      });
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(translateY, {
          toValue: SHEET_OFFSCREEN,
          duration: SHEET_EXIT_MS,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!rendered) return null;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onDismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <BlurView
          intensity={20}
          tint="light"
          blurMethod={SHEET_BLUR_METHOD}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.sheetTint} />
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      </Animated.View>

      <Animated.View
        style={[styles.sheetContainer, { transform: [{ translateY }] }]}
        pointerEvents="box-none"
      >
        <SafeAreaView
          edges={["bottom"]}
          style={[styles.sheetWrap, { maxHeight: Dimensions.get("window").height * 0.75 }]}
        >
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetGrabber} />
            <Text style={[styles.sheetTitle, textDir(isRTL)]}>{title}</Text>
            <ScrollView
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
                      <Text style={[styles.sheetRowLabel, textDir(isRTL)]}>{o.label}</Text>
                    </View>
                    {isSelected ? (
                      <Ionicons name="checkmark" size={18} color={colors.textEmphasis} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetTint: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.08)" },
  sheetContainer: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopRightRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingBottom: 0, flexShrink: 1 },
  sheetGrabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 4,
  },
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
  sheetRowLeading: {
    fontSize: 18,
    fontFamily: fonts.monoSemi,
    color: colors.textEmphasis,
    minWidth: 28,
  },
  sheetRowLabel: {
    fontSize: SETTINGS_ROW_LABEL_FONT_SIZE,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    flexShrink: 1,
  },
});
