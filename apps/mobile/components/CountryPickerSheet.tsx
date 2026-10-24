import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { useSheetDrag } from "../lib/use-sheet-drag";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Modal,
  Pressable,
  type ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { ltrIsolate, rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { getCountryName, type Country } from "../lib/phone";
import { searchCountries } from "../lib/country-search";
import { icon, radius } from "../lib/tokens";

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
  const [query, setQuery] = useState("");
  const { rendered, opacity, position: translateY } = useOverlayAnimation(props.visible, OFFSCREEN);
  const drag = useSheetDrag(props.visible, translateY, props.onDismiss);
  const isRTL = useIsRTL();
  const { height } = useWindowDimensions();
  const locale = getLocale();
  const filtered = useMemo(() => searchCountries(query), [query]);
  const listRef = useRef<FlatList<Country> | null>(null);
  const setListRef = useCallback(
    (list: FlatList<Country> | null) => {
      listRef.current = list;
      // The drag hook uses the underlying scroll identity to reset its offset;
      // it does not call ScrollView methods on this native host ref.
      drag.scrollProps.ref((list?.getNativeScrollRef() ?? null) as ScrollView | null);
    },
    [drag.scrollProps.ref],
  );

  useEffect(() => {
    if (props.visible) setQuery("");
  }, [props.visible]);

  useEffect(() => {
    if (props.visible) listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query, props.visible]);

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
        pointerEvents={props.visible ? "box-none" : "none"}
      >
        <SafeAreaView
          {...drag.surfacePanHandlers}
          edges={["bottom"]}
          style={[styles.sheetWrap, { maxHeight: height * 0.75 }]}
        >
          {/* No onStartShouldSetResponder here — it swallowed the ScrollView's
              pan so the country list couldn't be scrolled. The backdrop Pressable
              above already handles outside-taps. */}
          <View style={styles.sheet}>
            <SheetHandle panHandlers={drag.panHandlers} onDismiss={drag.dismiss} />
            <Text style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}>
              {t("country.title")}
            </Text>

            <View style={[styles.searchWrap, rowDir(isRTL)]}>
              <Ionicons
                name="search"
                size={icon.trailing}
                color={colors.textMuted}
                style={[styles.searchIcon, isRTL ? styles.searchIconRTL : styles.searchIconLTR]}
              />
              <TextInput
                style={[styles.searchInput, textDir(isRTL)]}
                value={query}
                onChangeText={setQuery}
                placeholder={t("country.search")}
                accessibilityLabel={t("country.search")}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <FlatList
              {...drag.scrollProps}
              ref={setListRef}
              data={filtered}
              extraData={`${locale}:${props.selectedCode}`}
              keyExtractor={(country) => country.code}
              initialNumToRender={14}
              maxToRenderPerBatch={12}
              windowSize={5}
              bounces={false}
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>{t("country.noMatch")}</Text>
                </View>
              }
              renderItem={({ item: c }) => {
                const selected = c.code === props.selectedCode;
                return (
                  <Pressable
                    key={c.code}
                    accessibilityRole="button"
                    accessibilityLabel={`${getCountryName(c.code, locale)} ${c.dialCode}`}
                    accessibilityState={{ selected }}
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
                    <Text style={[styles.name, textDir(isRTL)]} numberOfLines={2}>
                      {getCountryName(c.code, locale)}
                    </Text>
                    <Text style={[styles.dial, isRTL ? styles.dialRTL : styles.dialLTR]}>
                      {ltrIsolate(c.dialCode)}
                    </Text>
                    {selected ? (
                      <Ionicons
                        name="checkmark"
                        // icon.row (22), same tick size as OptionSheet. The
                        // styles.check box below is sized from the same token
                        // because the unselected branch renders it as an empty
                        // spacer — icon and spacer must stay identical or the
                        // dial codes jitter between selected/unselected rows.
                        size={icon.row}
                        color={colors.textEmphasis}
                        style={styles.check}
                      />
                    ) : (
                      <View style={styles.check} />
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Height is capped on the SafeAreaView with a concrete pixel value
    // (Dimensions * 0.75). A percentage maxHeight here didn't resolve — the
    // absolute parent has no fixed height — so the inner ScrollView had no
    // bounded viewport and couldn't scroll.
  },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    // Screen-anchored sheet top — radius.sheet (18). Same value as before.
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingBottom: 8, flexShrink: 1 },
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
    borderRadius: radius.sm,
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
  // Also rendered empty as the spacer for unselected rows — must track the
  // tick's icon.row size exactly (see the Ionicons above).
  check: { width: icon.row, height: icon.row },
  empty: { paddingVertical: 24, alignItems: "center" },
  emptyText: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
});
