import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type KeyboardEvent,
  type ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { currencyNeedsPrecisionHint, getCurrencyName } from "../lib/currency";
import { searchCurrencies } from "../lib/currency-catalog";
import { ltrIsolate, rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { icon, radius, typography } from "../lib/tokens";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { useSheetDrag } from "../lib/use-sheet-drag";
import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";

const OFFSCREEN = 1000;
type CurrencyOption = ReturnType<typeof searchCurrencies>[number];

/** One searchable picker for onboarding, new kaatas, and kaata settings. */
export function CurrencyPickerSheet(props: {
  visible: boolean;
  selectedCode: string;
  onSelect: (code: string) => void;
  onDismiss: () => void;
}) {
  const [query, setQuery] = useState("");
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [modalHeight, setModalHeight] = useState<number | null>(null);
  const listRef = useRef<FlatList<CurrencyOption> | null>(null);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isRTL = useIsRTL();
  const locale = getLocale();
  const { rendered, opacity, position } = useOverlayAnimation(props.visible, OFFSCREEN);
  const drag = useSheetDrag(props.visible, position, props.onDismiss);
  const setListRef = useCallback(
    (list: FlatList<CurrencyOption> | null) => {
      listRef.current = list;
      // FlatList's default scroll host is a ScrollView. SDK 57/RN exposes
      // that host through getNativeScrollRef (not getScrollRef).
      drag.scrollProps.ref((list?.getNativeScrollRef() ?? null) as ScrollView | null);
    },
    [drag.scrollProps.ref],
  );

  useEffect(() => {
    if (!props.visible) return;
    setQuery("");
    setModalHeight(null);
    setKeyboardTop(Keyboard.metrics()?.screenY ?? null);
    const move = (event: KeyboardEvent) => {
      if (Platform.OS === "ios") Keyboard.scheduleLayoutAnimation(event);
      setKeyboardTop(event.endCoordinates.screenY);
    };
    const frame = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      move,
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardTop(null));
    return () => {
      frame.remove();
      hide.remove();
    };
  }, [props.visible]);

  useEffect(() => {
    if (props.visible) listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [props.visible, query]);

  const currencies = useMemo(() => {
    const matches = searchCurrencies(query, locale);
    if (query.trim()) return matches;
    // A currency can be far down this long list. Keep the current choice in
    // view without assuming a fixed row height (names and large text wrap).
    const selected = matches.find((currency) => currency.code === props.selectedCode);
    return selected
      ? [selected, ...matches.filter((currency) => currency.code !== selected.code)]
      : matches;
  }, [query, locale, props.selectedCode]);

  if (!rendered) return null;

  // Android can resize the Modal independently of the Activity/window. Use
  // its measured viewport, or its keyboard overlap would be counted twice.
  const viewportHeight = modalHeight ?? height;
  const keyboardInset = keyboardTop === null ? 0 : Math.max(0, viewportHeight - keyboardTop);
  const availableHeight = Math.max(0, viewportHeight - keyboardInset - insets.top - 8);
  // iOS reports the outgoing frame before keyboardDidHide; restore the normal
  // height within that same animation rather than growing to full height first.
  const keyboardOpen = keyboardTop !== null && (Platform.OS !== "ios" || keyboardInset > 0);
  // Use the remaining space while searching. In landscape, the normal
  // handle/title chrome would consume all of it before a single result row.
  const compact = keyboardOpen && availableHeight < 240;
  const sheetHeight = keyboardOpen ? availableHeight : Math.min(height * 0.75, availableHeight);

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={drag.dismiss}
    >
      <View
        testID="currency-picker-viewport"
        style={styles.modalRoot}
        onLayout={(event) => {
          const measured = event.nativeEvent.layout.height;
          if (Number.isFinite(measured) && measured > 0) setModalHeight(measured);
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
          <SheetBackdrop onDismiss={drag.dismiss} />
        </Animated.View>
      </View>
      <Animated.View
        style={[
          styles.sheetContainer,
          { bottom: keyboardInset, transform: [{ translateY: drag.translateY }] },
        ]}
        pointerEvents={props.visible ? "box-none" : "none"}
      >
        <SafeAreaView
          {...drag.surfacePanHandlers}
          edges={keyboardOpen ? [] : ["bottom"]}
          style={[styles.sheet, compact && styles.sheetCompact, { height: sheetHeight }]}
        >
          {!compact ? (
            <>
              <SheetHandle panHandlers={drag.panHandlers} onDismiss={drag.dismiss} />
              <Text style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}>
                {t("currency.title")}
              </Text>
            </>
          ) : null}
          <View style={[styles.searchWrap, compact && styles.searchWrapCompact, rowDir(isRTL)]}>
            <Ionicons name="search" size={icon.trailing} color={colors.textMuted} />
            <TextInput
              style={[styles.searchInput, compact && styles.searchInputCompact, textDir(isRTL)]}
              value={query}
              onChangeText={setQuery}
              accessibilityLabel={t("currency.search")}
              placeholder={t("currency.search")}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={Keyboard.dismiss}
            />
            {compact ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
                onPress={drag.dismiss}
                style={styles.close}
              >
                <Ionicons name="close" size={icon.trailing} color={colors.textSubtle} />
              </Pressable>
            ) : null}
          </View>
          <FlatList
            {...drag.scrollProps}
            ref={setListRef}
            data={currencies}
            keyExtractor={(currency) => currency.code}
            extraData={`${props.selectedCode}:${locale}`}
            style={styles.list}
            contentContainerStyle={[styles.listContent, compact && styles.listContentCompact]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            bounces={false}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={5}
            ListEmptyComponent={
              <Text style={[styles.emptyText, textDir(isRTL)]}>{t("currency.noMatch")}</Text>
            }
            renderItem={({ item }) => {
              const selected = item.code === props.selectedCode;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${getCurrencyName(item.code)}, ${item.code}`}
                  accessibilityState={{ selected }}
                  onPress={() => {
                    props.onSelect(item.code);
                    drag.dismiss();
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    rowDir(isRTL),
                    pressed && { backgroundColor: colors.bgMuted },
                  ]}
                >
                  <View style={styles.rowText}>
                    <Text style={[styles.name, textDir(isRTL)]}>{getCurrencyName(item.code)}</Text>
                    <Text style={[styles.code, textDir(isRTL)]}>
                      {ltrIsolate(
                        item.symbol === item.code ? item.code : `${item.code}  ·  ${item.symbol}`,
                      )}
                    </Text>
                    {currencyNeedsPrecisionHint(item.code) ? (
                      <Text style={[styles.precisionHint, textDir(isRTL)]}>
                        {t("currency.precisionHint")}
                      </Text>
                    ) : null}
                  </View>
                  {selected ? (
                    <Ionicons
                      name="checkmark"
                      size={icon.row}
                      color={colors.actionPrimary}
                      style={styles.check}
                    />
                  ) : (
                    <View style={styles.check} />
                  )}
                </Pressable>
              );
            }}
          />
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1 },
  sheetContainer: { position: "absolute", left: 0, right: 0 },
  sheet: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
    paddingTop: 8,
  },
  sheetCompact: { paddingTop: 4 },
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
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    gap: 8,
  },
  searchWrapCompact: { marginBottom: 4 },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
  },
  searchInputCompact: { paddingVertical: 0 },
  close: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
  listContentCompact: { paddingBottom: 0 },
  row: {
    minHeight: 60,
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textEmphasis },
  code: { ...typography.caption, color: colors.textSubtle, marginTop: 2 },
  precisionHint: { ...typography.hint, color: colors.textSubtle, marginTop: 4 },
  check: { width: icon.row, height: icon.row },
  emptyText: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
});
