import type { TextInputInstance } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute, useRouter, type NativeStackNavigationProp } from "expo-router";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { rowDir, textDir } from "../lib/direction";
import { t } from "../lib/i18n";
import {
  cancelNativeSearchClose,
  closeNativeSearch,
  completeNativeSearchClose,
  createNativeSearch,
  publishNativeSearch,
} from "../lib/native-search";
import { icon, radius, TOUCH_MIN, typography } from "../lib/tokens";
import { ScreenHeader } from "./SettingsScreen";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";

/** Search, its filters, and its scrollable results share one keyboard-aware sheet. */
export type SearchSheetProps = {
  visible: boolean;
  contextKey: string;
  title: string;
  query: string;
  onChangeQuery: (query: string) => void;
  placeholder: string;
  resultSummary?: string;
  isRTL: boolean;
  onDismiss: () => void;
  dismissDisabled?: boolean;
  canDismiss?: () => boolean;
  filters?: ReactNode;
  filtersActive?: boolean;
  onClearAll?: () => void;
  footer?: ReactNode;
  /** Presented from the native search route, above its content and floating footer. */
  confirmation?: ComponentProps<typeof ConfirmDialog>;
  autoFocus?: boolean;
  children: ReactNode | ((footerInset: number) => ReactNode);
};

/** Keep ledger state live in its owner while native navigation presents search. */
export function SearchSheet(props: SearchSheetProps) {
  const router = useRouter();
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const latest = useRef(props);
  latest.current = props;
  const opening = useRef<{ id: string; contextKey: string } | null>(null);
  useLayoutEffect(() => {
    if (opening.current && (!props.visible || opening.current.contextKey !== props.contextKey)) {
      if (opening.current.contextKey !== props.contextKey) cancelNativeSearchClose(route.key);
      closeNativeSearch(opening.current.id, true, opening.current.contextKey !== props.contextKey);
      opening.current = null;
      Keyboard.dismiss();
    }
    if (!props.visible) return;
    const isNew = opening.current === null;
    if (!opening.current) {
      const contextKey = props.contextKey;
      const id = createNativeSearch(
        route.key,
        contextKey,
        () => {
          if (opening.current?.id === id && latest.current.contextKey === contextKey)
            latest.current.onDismiss();
        },
        () =>
          !latest.current.dismissDisabled &&
          !latest.current.confirmation?.visible &&
          (latest.current.canDismiss?.() ?? true),
      );
      opening.current = { id, contextKey };
    }
    const { id } = opening.current;
    publishNativeSearch(
      id,
      <SearchSheetContent {...props} key={id} onDismiss={() => closeNativeSearch(id)} />,
      !!props.dismissDisabled || !!props.confirmation?.visible,
    );
    if (isNew) router.push({ pathname: "/search", params: { sessionId: id, ownerKey: route.key } });
  });
  useEffect(
    () => () => {
      const id = opening.current?.id;
      opening.current = null;
      if (id) closeNativeSearch(id, true, true);
      cancelNativeSearchClose(route.key);
    },
    [route.key],
  );
  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = undefined;
    };
    const settle = () => {
      cancel();
      if (!navigation.isFocused()) return;
      // iOS page-sheet dismissal can skip the underlying screen's appearance
      // event. Keep a guarded fallback after the native transition has settled.
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (navigation.isFocused()) completeNativeSearchClose(route.key);
      }, 600);
    };
    const state = navigation.addListener("state", settle);
    const focus = navigation.addListener("focus", settle);
    const blur = navigation.addListener("blur", cancel);
    const transition = navigation.addListener("transitionEnd", (event) => {
      if (!event.data.closing && navigation.isFocused()) {
        cancel();
        completeNativeSearchClose(route.key);
      }
    });
    return () => {
      cancel();
      state();
      focus();
      blur();
      transition();
    };
  }, [navigation, route.key]);
  return null;
}

/** Matches Add Customer's SafeAreaView, shared header and native keyboard layout. */
export function SearchSheetContent(props: SearchSheetProps & { active?: boolean }) {
  const input = useRef<TextInputInstance>(null);
  const latest = useRef(props);
  latest.current = props;
  const session = useRef({ visible: props.visible, contextKey: props.contextKey, generation: 0 });
  if (
    session.current.visible !== props.visible ||
    session.current.contextKey !== props.contextKey
  ) {
    session.current = {
      visible: props.visible,
      contextKey: props.contextKey,
      generation: session.current.generation + 1,
    };
  }
  const generation = session.current.generation;
  const mounted = useRef(false);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [footerHeight, setFooterHeight] = useState(0);
  const confirmationState = useRef({
    visible: false,
    generation,
    handled: false,
    version: 0,
    content: undefined as SearchSheetProps["confirmation"],
  });
  const confirming = !!props.confirmation?.visible && props.active !== false;
  if (
    confirmationState.current.visible !== confirming ||
    confirmationState.current.generation !== generation
  ) {
    confirmationState.current = {
      visible: confirming,
      generation,
      handled: false,
      version: confirmationState.current.version + 1,
      content:
        confirmationState.current.generation === generation
          ? confirmationState.current.content
          : undefined,
    };
  }
  if (confirming) confirmationState.current.content = props.confirmation;
  const confirmationVersion = confirmationState.current.version;
  const controlsDisabled = () =>
    !!latest.current.dismissDisabled || !!latest.current.confirmation?.visible;
  const confirmationAction = (action: "onConfirm" | "onCancel" | "onTertiary") => {
    if (
      !current() ||
      !latest.current.confirmation?.visible ||
      latest.current.dismissDisabled ||
      confirmationState.current.version !== confirmationVersion ||
      confirmationState.current.handled
    )
      return;
    confirmationState.current.handled = true;
    latest.current.confirmation[action]?.();
  };
  const expanded = useRef(filtersExpanded);
  expanded.current = filtersExpanded;
  const cancelFocus = () => {
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = null;
  };
  const current = () =>
    mounted.current &&
    latest.current.active !== false &&
    session.current.generation === generation &&
    latest.current.visible &&
    latest.current.contextKey === props.contextKey;
  const focus = () => {
    cancelFocus();
    if (!current() || expanded.current || latest.current.autoFocus === false || controlsDisabled())
      return;
    const context = props.contextKey;
    focusTimer.current = setTimeout(() => {
      focusTimer.current = null;
      if (
        mounted.current &&
        latest.current.active !== false &&
        session.current.generation === generation &&
        latest.current.visible &&
        latest.current.autoFocus !== false &&
        !controlsDisabled() &&
        latest.current.contextKey === context &&
        !expanded.current
      )
        input.current?.focus();
    }, 280);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelFocus();
    };
  }, []);
  useEffect(() => {
    cancelFocus();
    expanded.current = false;
    setFiltersExpanded(false);
    if (!props.visible || props.active === false || props.autoFocus === false)
      input.current?.blur();
    else focus();
    return cancelFocus;
  }, [props.visible, props.contextKey, props.active, props.autoFocus]);
  useEffect(() => {
    if (!confirming) return;
    cancelFocus();
    input.current?.blur();
    Keyboard.dismiss();
  }, [confirming]);
  const dismiss = () => {
    if (!current() || controlsDisabled()) return;
    cancelFocus();
    input.current?.blur();
    Keyboard.dismiss();
    latest.current.onDismiss();
  };
  const showFilters = filtersExpanded && !!props.filters;
  const clearAll =
    props.onClearAll && (props.query.length > 0 || props.filtersActive) ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("search.clearAll")}
        disabled={props.dismissDisabled || confirming}
        accessibilityState={{ disabled: !!props.dismissDisabled || confirming }}
        onPress={() => {
          if (current() && !controlsDisabled()) latest.current.onClearAll?.();
        }}
        style={styles.clearAll}
      >
        <Text style={[styles.clearLabel, textDir(props.isRTL)]}>{t("search.clearAll")}</Text>
      </Pressable>
    ) : null;
  if (!props.visible) return null;
  return (
    <SafeAreaView style={styles.container}>
      <ScreenHeader
        title={props.title}
        onBack={dismiss}
        isRTL={props.isRTL}
        backLabel={t("common.close")}
        backDisabled={props.dismissDisabled || confirming}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.content}
      >
        <View style={[styles.searchRow, rowDir(props.isRTL)]}>
          <View style={[styles.field, rowDir(props.isRTL)]}>
            <Ionicons name="search-outline" size={icon.row} color={colors.textSubtle} />
            <TextInput
              ref={input}
              accessibilityLabel={props.placeholder}
              placeholder={props.placeholder}
              placeholderTextColor={colors.textMuted}
              value={props.query}
              editable={!props.dismissDisabled && !confirming}
              onChangeText={(query) => {
                if (current() && !controlsDisabled()) latest.current.onChangeQuery(query);
              }}
              onFocus={() => {
                if (!current() || controlsDisabled()) return;
                expanded.current = false;
                setFiltersExpanded(false);
              }}
              style={[styles.input, textDir(props.isRTL)]}
              autoCorrect={false}
              returnKeyType="search"
              submitBehavior="blurAndSubmit"
              onSubmitEditing={() => {
                if (current() && !controlsDisabled()) {
                  input.current?.blur();
                  Keyboard.dismiss();
                }
              }}
              maxLength={500}
            />
            {props.query.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("search.clearQuery")}
                disabled={props.dismissDisabled || confirming}
                accessibilityState={{ disabled: !!props.dismissDisabled || confirming }}
                style={styles.icon}
                onPress={() => {
                  if (current() && !controlsDisabled()) latest.current.onChangeQuery("");
                }}
              >
                <Ionicons name="close-circle" size={icon.trailing} color={colors.textMuted} />
              </Pressable>
            ) : null}
          </View>
          {props.filters ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("search.filters")}
              accessibilityState={{
                expanded: filtersExpanded,
                selected: !!props.filtersActive,
                disabled: !!props.dismissDisabled || confirming,
              }}
              disabled={props.dismissDisabled || confirming}
              onPress={() => {
                if (!current() || controlsDisabled()) return;
                cancelFocus();
                input.current?.blur();
                Keyboard.dismiss();
                expanded.current = !expanded.current;
                setFiltersExpanded(expanded.current);
              }}
              style={[
                styles.filterButton,
                (props.filtersActive || showFilters) && styles.filterActive,
              ]}
            >
              <Ionicons
                name="options-outline"
                size={icon.row}
                color={
                  props.filtersActive || showFilters ? colors.textInverted : colors.textDefault
                }
              />
            </Pressable>
          ) : null}
        </View>
        {showFilters ? (
          <View style={styles.filterPanel} testID="search-filter-panel">
            <View style={[styles.filterHeading, rowDir(props.isRTL)]}>
              <Text accessibilityRole="header" style={[styles.filterTitle, textDir(props.isRTL)]}>
                {t("search.filters")}
              </Text>
              {clearAll}
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              pointerEvents={props.dismissDisabled || confirming ? "none" : "auto"}
              style={styles.filterScroll}
              contentContainerStyle={styles.filters}
            >
              {props.filters}
            </ScrollView>
            <View style={styles.filterFooter}>
              <Button
                fullWidth
                size="hero"
                label={t("search.showResults")}
                icon="checkmark-outline"
                disabled={props.dismissDisabled || confirming}
                onPress={() => {
                  if (!current() || controlsDisabled()) return;
                  expanded.current = false;
                  setFiltersExpanded(false);
                }}
              />
            </View>
          </View>
        ) : null}
        <View
          style={[styles.results, showFilters && styles.hidden]}
          testID="search-results-panel"
          accessibilityElementsHidden={showFilters}
          importantForAccessibility={showFilters ? "no-hide-descendants" : "auto"}
        >
          {props.resultSummary !== undefined ? (
            <View style={[styles.summaryRow, rowDir(props.isRTL)]} testID="search-results-summary">
              <Text
                style={[styles.summaryText, textDir(props.isRTL)]}
                accessibilityLiveRegion="polite"
              >
                {props.resultSummary}
              </Text>
              {clearAll}
            </View>
          ) : clearAll ? (
            <View style={styles.clearRow}>{clearAll}</View>
          ) : null}
          <View style={styles.results}>
            {typeof props.children === "function"
              ? props.children(props.footer ? footerHeight : 0)
              : props.children}
          </View>
          {props.footer ? (
            <View
              pointerEvents="box-none"
              testID="search-selection-overlay"
              style={styles.footer}
              onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.footerContent}
                style={styles.footerScroll}
              >
                {props.footer}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
      {props.confirmation ? (
        <ConfirmDialog
          {...(confirmationState.current.content ?? props.confirmation)}
          visible={confirming}
          onConfirm={() => confirmationAction("onConfirm")}
          onCancel={() => confirmationAction("onCancel")}
          onTertiary={
            props.confirmation.onTertiary ? () => confirmationAction("onTertiary") : undefined
          }
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDefault,
  },
  content: { flex: 1 },
  searchRow: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  field: {
    flex: 1,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    gap: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    alignItems: "center",
  },
  input: {
    ...typography.body,
    color: colors.textDefault,
    flex: 1,
    minWidth: 0,
    paddingVertical: 12,
  },
  icon: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  filterButton: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  filterActive: { backgroundColor: colors.actionPrimary, borderColor: colors.actionPrimary },
  clearRow: { alignItems: "flex-end", paddingHorizontal: 16 },
  summaryRow: {
    alignItems: "center",
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 12,
  },
  summaryText: { ...typography.bodySm, flex: 1, minWidth: 0, color: colors.textSubtle },
  clearAll: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    paddingHorizontal: 8,
    justifyContent: "center",
  },
  clearLabel: { ...typography.bodySm, color: colors.textDefault },
  filterPanel: { flex: 1, minHeight: 0, backgroundColor: colors.bgMuted },
  filterHeading: { alignItems: "center", minHeight: TOUCH_MIN, paddingHorizontal: 16, gap: 8 },
  filterTitle: { ...typography.title, flex: 1, color: colors.textEmphasis },
  filterScroll: { flex: 1, minHeight: 0 },
  filters: { paddingBottom: 16 },
  filterFooter: {
    flexShrink: 0,
    padding: 16,
    backgroundColor: colors.bgDefault,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
  },
  results: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: "60%",
    backgroundColor: "transparent",
  },
  footerScroll: { flexGrow: 0, backgroundColor: "transparent" },
  footerContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8 },
});
