import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { COUNTRIES } from "../lib/phone";

// Slide-up sheet that mirrors BottomSheet's chrome (blur backdrop + tint +
// spring entrance) but holds a searchable list instead of a small action set.
// Used to pick a country dial code for phone input — see person/new and
// person/[id]/edit.

const OFFSCREEN = 800;

export function CountryPickerSheet(props: {
  visible: boolean;
  selectedCode: string;
  onSelect: (countryCode: string) => void;
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const [query, setQuery] = useState("");
  const isRTL = useIsRTL();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(OFFSCREEN)).current;

  useEffect(() => {
    if (props.visible) {
      setRendered(true);
      setQuery("");
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
        Animated.timing(translateY, { toValue: OFFSCREEN, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  if (!rendered) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? COUNTRIES.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.dialCode.includes(query.trim()) ||
          c.code.toLowerCase().includes(q),
      )
    : COUNTRIES;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={props.onDismiss}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <BlurView
          intensity={20}
          tint="light"
          experimentalBlurMethod={SHEET_BLUR_METHOD}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.tint} />
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onDismiss} />
      </Animated.View>

      <Animated.View
        style={[styles.sheetContainer, { transform: [{ translateY }] }]}
        pointerEvents="box-none"
      >
        <SafeAreaView edges={["bottom"]} style={styles.sheetWrap}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.grabber} />
            <Text style={[styles.title, textDir(isRTL)]}>{t("country.title")}</Text>

            <View style={[styles.searchWrap, rowDir(isRTL)]}>
              <Ionicons
                name="search"
                size={16}
                color={colors.textMuted}
                style={[styles.searchIcon, isRTL ? styles.searchIconRTL : styles.searchIconLTR]}
              />
              <TextInput
                style={[styles.searchInput, textDir(isRTL)]}
                value={query}
                onChangeText={setQuery}
                placeholder={t("country.search")}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              contentContainerStyle={styles.listContent}
            >
              {filtered.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>{t("country.noMatch")}</Text>
                </View>
              ) : (
                filtered.map((c) => {
                  const selected = c.code === props.selectedCode;
                  return (
                    <Pressable
                      key={c.code}
                      onPress={() => {
                        props.onSelect(c.code);
                        props.onDismiss();
                      }}
                      style={({ pressed }) => [
                        styles.row,
                        rowDir(isRTL),
                        pressed && { backgroundColor: colors.bgMuted },
                      ]}
                    >
                      <Text style={[styles.flag, isRTL ? styles.flagRTL : styles.flagLTR]}>
                        {c.flag}
                      </Text>
                      <Text style={[styles.name, textDir(isRTL)]} numberOfLines={1}>
                        {c.name}
                      </Text>
                      <Text style={[styles.dial, isRTL ? styles.dialRTL : styles.dialLTR]}>
                        {c.dialCode}
                      </Text>
                      {selected ? (
                        <Ionicons
                          name="checkmark"
                          size={18}
                          color={colors.textEmphasis}
                          style={styles.check}
                        />
                      ) : (
                        <View style={styles.check} />
                      )}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.08)" },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Cap the sheet height so it doesn't take the whole screen on tall devices.
    maxHeight: "75%",
  },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingBottom: 8, flexShrink: 1 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 8,
  },
  title: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
    paddingLeft: 12,
  },
  searchIcon: {},
  searchIconLTR: { marginRight: 8 },
  searchIconRTL: { marginLeft: 8 },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    paddingRight: 12,
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
  },
  list: { flexShrink: 1 },
  listContent: { paddingBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  flag: { fontSize: 20 },
  flagLTR: { marginRight: 14 },
  flagRTL: { marginLeft: 14 },
  name: {
    flex: 1,
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
  },
  dial: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
    color: colors.textSubtle,
  },
  dialLTR: { marginRight: 12 },
  dialRTL: { marginLeft: 12 },
  check: { width: 18, height: 18 },
  empty: { paddingVertical: 24, alignItems: "center" },
  emptyText: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
});
