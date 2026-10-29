import { Ionicons } from "@expo/vector-icons";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  Dimensions,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ScrollViewInstance,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { colors } from "../lib/colors";
import {
  selectedCustomerCurrencyCodes,
  type CustomerBalanceFilter,
  type CustomerCurrencyFilter,
} from "../lib/customer-list";
import { getCurrentCurrencyCode, getCurrencyLabel, getCurrencySymbol } from "../lib/currency";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import { t } from "../lib/i18n";
import { currencyBalances } from "../lib/multi-currency-view";
import type { PersonWithBalance } from "../lib/types";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Use the same balance colors as the customer page for amounts and arrows.
const board = {
  surface: colors.bgDefault,
  header: colors.bgMuted,
  rule: colors.borderDefault,
  text: colors.textEmphasis,
  muted: colors.textSubtle,
  collect: colors.collectStrong,
  pay: colors.payStrong,
} as const;

export type HomeCurrencyBalance = {
  currency: string;
  collect: number;
  pay: number;
  pending: boolean;
};

export function visibleCurrencyBalances(
  balances: readonly HomeCurrencyBalance[],
  fallback: string,
): HomeCurrencyBalance[] {
  const unique = [...new Map(balances.map((row) => [row.currency, row])).values()];
  const active = unique.filter((row) => row.pending || row.collect !== 0 || row.pay !== 0);
  return active.length
    ? active
    : [
        unique.find((row) => row.currency === fallback) ?? {
          currency: fallback,
          collect: 0,
          pay: 0,
          pending: false,
        },
      ];
}

/** One fixed-height board per currency. Its two sides also control the list's
 * balance filter, while native horizontal scrolling moves between currencies. */
export function HomeBalanceSummary({
  people,
  balances,
  currency = getCurrentCurrencyCode(),
  searchOpen = false,
  active = true,
  direction: balanceDirection = "all",
  currencyFilter,
  onDirectionChange,
  interactionEnabled = true,
}: {
  people: readonly PersonWithBalance[];
  balances?: readonly HomeCurrencyBalance[];
  currency?: string;
  searchOpen?: boolean;
  active?: boolean;
  direction?: CustomerBalanceFilter;
  currencyFilter?: CustomerCurrencyFilter;
  onDirectionChange?: (side: "collect" | "pay", currency: string) => void;
  interactionEnabled?: boolean;
}) {
  const isRTL = useIsRTL();
  const focused = useIsFocused();
  const { width, fontScale = 1 } = useWindowDimensions();
  // Android can resize the window for the IME. Only the physical screen size
  // selects the small-screen layout, so opening search never shrinks the cards.
  const small = Dimensions.get("screen").height < 500;
  const rows = visibleCurrencyBalances(balances ?? currencyBalances(people, currency), currency);
  const codes = JSON.stringify(rows.map((row) => row.currency));
  const scroll = useRef<ScrollViewInstance | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const viewport = measuredWidth || Math.max(0, width - 32);
  const multiple = rows.length > 1;
  const pageWidth = Math.max(0, viewport);
  const step = pageWidth + 12;
  const cardHeight =
    (small ? (fontScale > 1.3 ? 114 : 104) : fontScale > 1.3 ? 144 : 132) -
    (multiple ? 0 : small ? 28 : 32);
  const selectedCurrencies = selectedCustomerCurrencyCodes(currencyFilter);
  const [position, setPosition] = useState(0);
  const selectedCode = useRef(rows[0].currency);
  const offset = useRef(0);
  const stopped = useRef(false);
  const [manuallyStopped, setManuallyStopped] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [windowFocused, setWindowFocused] = useState(true);
  // Wait for both queries before starting motion. An initial async response
  // must not overwrite a preference changed while that query was in flight.
  const [screenReader, setScreenReader] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);
  // Only two extra cards are needed for a seamless edge in either direction.
  // Assistive navigation uses the real cards and wraps through its controls.
  const loop = multiple && !screenReader;
  const geometry = useRef({ codes, step, loop, epoch: 0 });
  const previousGeometry = geometry.current;
  if (
    previousGeometry.codes !== codes ||
    previousGeometry.step !== step ||
    previousGeometry.loop !== loop
  )
    geometry.current = { codes, step, loop, epoch: previousGeometry.epoch + 1 };
  const epoch = geometry.current.epoch;
  const retainedIndex = rows.findIndex((row) => row.currency === selectedCode.current);
  const alignedIndex =
    retainedIndex < 0 ? Math.max(0, Math.min(rows.length - 1, position)) : retainedIndex;
  const initialOffset = useRef({ epoch: -1, x: 0 });
  if (initialOffset.current.epoch !== epoch) {
    initialOffset.current = { epoch, x: (alignedIndex + (loop ? 1 : 0)) * step };
    offset.current = initialOffset.current.x;
    selectedCode.current = rows[alignedIndex].currency;
  }
  const dragging = useRef(false);
  const touching = useRef(false);
  const nativeCommand = useRef<{ epoch: number; x: number; animated: boolean } | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleVersion = useRef(0);
  useEffect(() => {
    let alive = true;
    let readerChanged = false;
    let motionChanged = false;
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", (value) => {
      readerChanged = true;
      if (alive) setScreenReader(value);
    });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      motionChanged = true;
      if (alive) setReducedMotion(value);
    });
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (alive && !readerChanged) setScreenReader(value);
      })
      .catch(() => undefined);
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive && !motionChanged) setReducedMotion(value);
      })
      .catch(() => undefined);
    const app = AppState.addEventListener("change", (value) => {
      if (alive) setAppState(value);
    });
    const blur =
      Platform.OS === "android"
        ? AppState.addEventListener("blur", () => {
            if (alive) setWindowFocused(false);
          })
        : null;
    const focus =
      Platform.OS === "android"
        ? AppState.addEventListener("focus", () => {
            if (alive) setWindowFocused(true);
          })
        : null;
    return () => {
      alive = false;
      reader.remove();
      motion.remove();
      app.remove();
      blur?.remove();
      focus?.remove();
    };
  }, []);
  const autoAllowed =
    active &&
    focused &&
    appState === "active" &&
    windowFocused &&
    !small &&
    !searchOpen &&
    !screenReader &&
    !reducedMotion &&
    !manuallyStopped &&
    multiple &&
    measuredWidth > 0;
  const latest = useRef({ autoAllowed, epoch });
  latest.current = { autoAllowed, epoch };
  const mounted = useRef(true);
  const latestInteraction = useRef({
    onDirectionChange,
    currencies: rows.map((row) => row.currency),
    enabled: false,
  });
  latestInteraction.current = {
    onDirectionChange,
    currencies: rows.map((row) => row.currency),
    enabled: interactionEnabled && active && focused && appState === "active" && windowFocused,
  };
  const timerVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      timerVersion.current++;
      settleVersion.current++;
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = null;
    };
  }, []);
  const stopAutomaticScroll = () => {
    if (!mounted.current) return;
    stopped.current = true;
    setManuallyStopped(true);
  };
  const toggleDirection = (side: "collect" | "pay", rowCurrency: string) => {
    const latest = latestInteraction.current;
    if (
      !mounted.current ||
      !latest.enabled ||
      !latest.onDirectionChange ||
      !latest.currencies.includes(rowCurrency)
    )
      return;
    stopAutomaticScroll();
    latest.onDirectionChange(side, rowCurrency);
  };
  const currentGeometry = () => mounted.current && latest.current.epoch === epoch;
  const cancelSettle = () => {
    settleVersion.current++;
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  };
  const physicalIndex = (x: number) =>
    Math.max(0, Math.min(rows.length - 1 + (loop ? 2 : 0), Math.round(x / step)));
  const logicalIndex = (physical: number) =>
    loop ? (physical - 1 + rows.length) % rows.length : physical;
  const observeOffset = (x: number) => {
    if (!currentGeometry() || !Number.isFinite(x)) return false;
    offset.current = Math.max(0, Math.min((rows.length - 1 + (loop ? 2 : 0)) * step, x));
    const logical = logicalIndex(physicalIndex(offset.current));
    selectedCode.current = rows[logical].currency;
    setPosition(logical);
    return true;
  };
  const scrollToPhysical = (physical: number, animated: boolean) => {
    if (!currentGeometry()) return;
    cancelSettle();
    const next = physicalIndex(physical * step);
    const x = next * step;
    // Update before the native command: a nonanimated scroll can synchronously
    // finish on iOS, and an interrupted Android animation can emit an old end.
    nativeCommand.current = { epoch, x, animated };
    offset.current = x;
    if (!animated) {
      const logical = logicalIndex(next);
      selectedCode.current = rows[logical].currency;
      setPosition(logical);
    }
    scroll.current?.scrollTo({ x, animated });
  };
  const boundaryPage = (x = offset.current) => {
    if (!loop || !Number.isFinite(x)) return null;
    const physical = physicalIndex(x);
    if (Math.abs(x - physical * step) > 1) return null;
    return physical === 0 ? rows.length : physical === rows.length + 1 ? 1 : null;
  };
  const settleBoundary = () => {
    if (!currentGeometry() || dragging.current || touching.current) return;
    const target = boundaryPage();
    if (target !== null) scrollToPhysical(target, false);
  };
  const queueBoundarySettle = (endX?: number) => {
    cancelSettle();
    if (
      !currentGeometry() ||
      dragging.current ||
      touching.current ||
      (endX === undefined ? boundaryPage() === null : !Number.isFinite(endX))
    )
      return;
    const version = settleVersion.current;
    // A slow drag may end without momentum. Only recycle after native scroll
    // events have been quiet, never underneath an active finger or glide.
    settleTimer.current = setTimeout(() => {
      if (!currentGeometry() || settleVersion.current !== version) return;
      settleTimer.current = null;
      if (dragging.current || touching.current) return;
      if (endX !== undefined) {
        // Momentum end can contain a newer final offset than the throttled
        // onScroll stream. Adopt it only after no newer motion has arrived.
        observeOffset(endX);
        nativeCommand.current = { epoch, x: offset.current, animated: false };
      }
      settleBoundary();
    }, 140);
  };
  const scrollToPosition = (index: number, animated: boolean) => {
    const next = ((index % rows.length) + rows.length) % rows.length;
    scrollToPhysical(next + (loop ? 1 : 0), animated);
  };
  // Retire old native callbacks with the old geometry. The new scroller starts
  // at the retained real currency before its first frame, not at a clone.
  useEffect(() => {
    dragging.current = false;
    touching.current = false;
    cancelSettle();
    scrollToPosition(alignedIndex, false);
    return cancelSettle;
    // Amount refreshes retain both the geometry and manual control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);
  useEffect(() => {
    const version = ++timerVersion.current;
    if (!autoAllowed) return;
    let timer: ReturnType<typeof setTimeout>;
    const queue = () => {
      timer = setTimeout(() => {
        if (
          !mounted.current ||
          version !== timerVersion.current ||
          stopped.current ||
          !latest.current.autoAllowed ||
          latest.current.epoch !== epoch ||
          !scroll.current
        )
          return;
        // A missed native end cannot strand autoplay at a sentinel. Normalize
        // invisibly first, then always advance one adjacent card forward.
        settleBoundary();
        scrollToPhysical(physicalIndex(offset.current) + 1, true);
        queue();
      }, 5000);
    };
    queue();
    return () => {
      timerVersion.current++;
      clearTimeout(timer);
    };
    // The trailing first-currency copy makes the last-to-first turn adjacent.
    // A refresh does not restart the cadence or resume manual control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAllowed, epoch]);
  const shownPosition = Math.max(0, Math.min(position, rows.length - 1));
  const current = rows[shownPosition];
  const pages = [
    ...(loop ? [{ row: rows[rows.length - 1], kind: "leading" as const }] : []),
    ...rows.map((row) => ({ row, kind: "real" as const })),
    ...(loop ? [{ row: rows[0], kind: "trailing" as const }] : []),
  ];
  const summaryLabel = current.pending
    ? `${getCurrencyLabel(current.currency)}, ${t("home.total.pending")}`
    : `${getCurrencyLabel(current.currency)}, ${t("home.total.label.collect")}: ${formatAmount(current.collect)}, ${t("home.total.label.pay")}: ${formatAmount(current.pay)}`;
  const thumbWidth = Math.min(viewport, Math.max(24, viewport / rows.length));
  return (
    <View
      style={[styles.summary, small && styles.compactSummary]}
      onTouchStart={() => {
        if (!currentGeometry()) return;
        touching.current = true;
        cancelSettle();
        stopAutomaticScroll();
      }}
      onTouchEnd={() => {
        if (!currentGeometry()) return;
        touching.current = false;
        queueBoundarySettle();
      }}
      onTouchCancel={() => {
        if (!currentGeometry()) return;
        touching.current = false;
        queueBoundarySettle();
      }}
      accessible={false}
    >
      <ScrollView
        key={epoch}
        ref={scroll}
        contentOffset={{ x: initialOffset.current.x, y: 0 }}
        horizontal
        accessible={false}
        style={{ height: cardHeight, flexGrow: 0, direction: "ltr" }}
        contentContainerStyle={{ gap: 12, direction: "ltr" }}
        scrollEnabled={multiple}
        showsHorizontalScrollIndicator={false}
        // Absolute targets avoid accumulated interval rounding on Android
        // phones whose density turns the inter-card gap into half a pixel.
        snapToOffsets={pages.map((_, index) => index * step)}
        decelerationRate="fast"
        bounces={multiple && !loop}
        overScrollMode={multiple && !loop ? "auto" : "never"}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.width;
          if (currentGeometry() && Number.isFinite(next) && next > 0) setMeasuredWidth(next);
        }}
        onScrollBeginDrag={() => {
          if (!currentGeometry()) return;
          stopAutomaticScroll();
          dragging.current = true;
          nativeCommand.current = null;
          cancelSettle();
        }}
        onScroll={(event) => {
          const x = event.nativeEvent.contentOffset.x;
          if (observeOffset(x)) queueBoundarySettle();
        }}
        onScrollEndDrag={(event) => {
          if (!currentGeometry()) return;
          dragging.current = false;
          touching.current = false;
          if (observeOffset(event.nativeEvent.contentOffset.x)) {
            const velocity = event.nativeEvent.velocity?.x;
            const target = event.nativeEvent.targetContentOffset?.x;
            const stoppedAtEdge =
              Number.isFinite(velocity) &&
              Math.abs(velocity ?? 0) < 0.01 &&
              (!Number.isFinite(target) || Math.abs((target ?? 0) - offset.current) <= 1);
            if (stoppedAtEdge) settleBoundary();
            else queueBoundarySettle();
          }
        }}
        onMomentumScrollBegin={() => {
          if (currentGeometry()) cancelSettle();
        }}
        onMomentumScrollEnd={(event) => {
          if (!currentGeometry() || dragging.current || touching.current) return;
          const x = event.nativeEvent.contentOffset.x;
          // Ignore an older animation's end, including the sentinel end which
          // follows our own nonanimated recenter command.
          if (!Number.isFinite(x)) return;
          const command = nativeCommand.current;
          if (command?.epoch === epoch) {
            if (Math.abs(x - command.x) > 1) return;
          } else if (Math.abs(x - offset.current) > 1) {
            queueBoundarySettle(x);
            return;
          }
          cancelSettle();
          if (observeOffset(x)) {
            nativeCommand.current = { epoch, x, animated: false };
            settleBoundary();
          }
        }}
        scrollEventThrottle={64}
        keyboardShouldPersistTaps="always"
      >
        {pages.map(({ row, kind }) => (
          <CurrencyBalanceCard
            key={`${row.currency}:${kind}`}
            idPrefix={kind === "real" ? "home-balance" : `home-balance-loop-${kind}`}
            row={row}
            multiple={multiple}
            pageWidth={pageWidth}
            cardHeight={cardHeight}
            small={small}
            fontScale={fontScale}
            isRTL={isRTL}
            reducedMotion={reducedMotion}
            direction={
              selectedCurrencies.length === 0 || selectedCurrencies.includes(row.currency)
                ? balanceDirection
                : "all"
            }
            visible={kind === "real" && row.currency === current.currency}
            enabled={latestInteraction.current.enabled && !!onDirectionChange}
            onDirectionChange={toggleDirection}
          />
        ))}
      </ScrollView>
      {multiple ? (
        <View
          testID="home-balance-currency-navigation"
          style={styles.track}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={summaryLabel}
          accessibilityValue={{ min: 1, max: rows.length, now: shownPosition + 1 }}
          accessibilityActions={[
            { name: "increment", label: t("home.total.nextCurrency") },
            { name: "decrement", label: t("home.total.previousCurrency") },
          ]}
          onAccessibilityTap={stopAutomaticScroll}
          onAccessibilityAction={(event) => {
            stopAutomaticScroll();
            if (event.nativeEvent.actionName === "increment")
              scrollToPosition(shownPosition + 1, false);
            else if (event.nativeEvent.actionName === "decrement")
              scrollToPosition(shownPosition - 1, false);
          }}
        >
          <View
            style={[
              styles.thumb,
              {
                width: thumbWidth,
                transform: [
                  { translateX: ((viewport - thumbWidth) * shownPosition) / (rows.length - 1) },
                ],
              },
            ]}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Each denomination owns its animation so a currency-specific filter never
 * stretches another currency's collect/pay pair. */
function CurrencyBalanceCard({
  idPrefix = "home-balance",
  row,
  multiple,
  pageWidth,
  cardHeight,
  small,
  fontScale,
  isRTL,
  reducedMotion,
  direction,
  visible,
  enabled,
  onDirectionChange,
}: {
  idPrefix?: string;
  row: HomeCurrencyBalance;
  multiple: boolean;
  pageWidth: number;
  cardHeight: number;
  small: boolean;
  fontScale: number;
  isRTL: boolean;
  reducedMotion: boolean;
  direction: CustomerBalanceFilter;
  visible: boolean;
  enabled: boolean;
  onDirectionChange: (side: "collect" | "pay", currency: string) => void;
}) {
  const innerWidth = Math.max(0, pageWidth - 2);
  const compactWidth = Math.min(innerWidth / 2, fontScale > 1.3 ? 92 : 80);
  const targetCollectWidth =
    direction === "collect"
      ? innerWidth - compactWidth
      : direction === "pay"
        ? compactWidth
        : innerWidth / 2;
  const amountWidth = Math.max(
    1,
    (direction === "all" ? innerWidth / 2 : innerWidth - compactWidth) - (small ? 16 : 24) - 1,
  );
  const collectWidth = useSharedValue(targetCollectWidth);
  const collectStyle = useAnimatedStyle(() => ({
    width: Math.max(0, Math.min(innerWidth, collectWidth.value)),
  }));
  const payStyle = useAnimatedStyle(() => ({
    width: Math.max(0, innerWidth - collectWidth.value),
  }));
  const previousPageWidth = useRef(pageWidth);
  useEffect(() => {
    // Resize immediately when rotating; only the user's filter change stretches
    // the pair. Amount refreshes and keyboard events never restart this motion.
    const resized = previousPageWidth.current !== pageWidth;
    previousPageWidth.current = pageWidth;
    if (!resized && collectWidth.value === targetCollectWidth) return;
    collectWidth.value =
      reducedMotion || resized
        ? targetCollectWidth
        : withTiming(targetCollectWidth, { duration: 200 });
  }, [targetCollectWidth, pageWidth, reducedMotion, collectWidth]);
  return (
    <View
      testID={`${idPrefix}-${row.currency}`}
      style={[styles.page, { width: pageWidth, height: cardHeight }]}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      {multiple ? (
        <View style={[styles.boardHeader, small && styles.compactHeader]}>
          <Text
            testID={`${idPrefix}-currency-${row.currency}`}
            accessible={false}
            style={styles.currency}
            maxFontSizeMultiplier={1.2}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {getCurrencyLabel(row.currency)}
          </Text>
          <Text
            accessible={false}
            style={[styles.boardCaption, textDir(isRTL)]}
            maxFontSizeMultiplier={1.2}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {t("home.total.title")}
          </Text>
        </View>
      ) : null}
      <View style={styles.quoteRow}>
        {(["collect", "pay"] as const).map((side) => {
          const collect = side === "collect";
          const selected = direction === side;
          const compact = direction !== "all" && !selected;
          const title = t(collect ? "home.total.label.collect" : "home.total.label.pay");
          const tone = collect ? board.collect : board.pay;
          const amount = row.pending ? "…" : formatAmount(row[side]);
          const symbol = multiple ? null : getCurrencySymbol(row.currency);
          const symbolSize = small ? 12 : 14;
          const symbolWidth = symbol
            ? symbol.length * symbolSize * 0.8 * Math.max(1, Math.min(fontScale, 1.2)) + 6
            : 0;
          const amountSize = amount.length > 10 ? (small ? 16 : 18) : small ? 20 : 30;
          // Keep every digit even at the largest supported money values.
          // Mono glyphs use about 0.6em; leave headroom for scaled fonts.
          const minimumScale = Math.min(
            0.5,
            Math.max(
              0.01,
              Math.max(1, amountWidth - symbolWidth) /
                (amount.length * amountSize * 0.65 * Math.max(1, Math.min(fontScale, 1.2))),
            ),
          );
          return (
            <AnimatedPressable
              key={side}
              testID={`${idPrefix}-${side}-${row.currency}`}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${getCurrencyLabel(row.currency)}, ${title}: ${amount}`}
              accessibilityHint={selected ? t("customers.balanceFilter.clear") : undefined}
              accessibilityState={{
                selected,
                disabled: !enabled,
              }}
              disabled={!enabled}
              onPress={() => onDirectionChange(side, row.currency)}
              style={[
                styles.card,
                !collect && styles.payCard,
                small && styles.compactCard,
                compact && styles.collapsedCard,
                selected && {
                  backgroundColor: collect ? colors.collectBg : colors.payBg,
                },
                collect ? collectStyle : payStyle,
              ]}
            >
              <View style={[styles.heading, compact && styles.collapsedHeading]}>
                <Ionicons
                  name={collect ? "arrow-down-outline" : "arrow-up-outline"}
                  size={compact ? 18 : 12}
                  color={tone}
                />
                <Text
                  accessible={false}
                  style={[
                    styles.label,
                    textDir(isRTL),
                    compact && styles.collapsedLabel,
                    selected && { color: tone },
                  ]}
                  numberOfLines={compact ? 2 : 1}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={1.3}
                >
                  {title}
                </Text>
              </View>
              {!compact ? (
                <View style={styles.values}>
                  <View style={styles.valueRow}>
                    {symbol ? (
                      <Text
                        testID={`${idPrefix}-symbol-${side}-${row.currency}`}
                        accessible={false}
                        style={[
                          styles.amountSymbol,
                          {
                            color: row.pending || row[side] === 0 ? board.muted : tone,
                            fontSize: symbolSize,
                          },
                        ]}
                        numberOfLines={1}
                        maxFontSizeMultiplier={1.2}
                      >
                        {symbol}
                      </Text>
                    ) : null}
                    <Text
                      accessible={false}
                      style={[
                        styles.amount,
                        {
                          color: row.pending || row[side] === 0 ? board.muted : tone,
                          fontSize: amountSize,
                        },
                      ]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={minimumScale}
                      maxFontSizeMultiplier={1.2}
                    >
                      {amount}
                    </Text>
                  </View>
                </View>
              ) : null}
            </AnimatedPressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 16,
    direction: "ltr",
    flexShrink: 0,
  },
  compactSummary: { marginTop: 2, marginBottom: 8 },
  page: {
    direction: "ltr",
    backgroundColor: board.surface,
    borderWidth: 1,
    borderColor: board.rule,
    borderRadius: 12,
    overflow: "hidden",
  },
  boardHeader: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: board.header,
    borderBottomWidth: 1,
    borderBottomColor: board.rule,
  },
  compactHeader: { paddingHorizontal: 8, paddingVertical: 4 },
  boardCaption: { fontSize: 11, fontFamily: fonts.sansMedium, color: board.muted, flexShrink: 1 },
  quoteRow: { flex: 1, minHeight: 0, flexDirection: "row", direction: "ltr" },
  card: { flexShrink: 0, minWidth: 0, paddingHorizontal: 12, paddingVertical: 10 },
  payCard: { borderLeftWidth: 1, borderLeftColor: board.rule },
  compactCard: { paddingHorizontal: 8, paddingVertical: 6 },
  collapsedCard: { justifyContent: "center", paddingHorizontal: 8 },
  heading: { flexDirection: "row", alignItems: "center", gap: 5, direction: "ltr" },
  collapsedHeading: { flexDirection: "column", gap: 6 },
  collapsedLabel: { flex: 0, textAlign: "center", color: board.text },
  label: { flex: 1, fontSize: 11, fontFamily: fonts.sansMedium, color: board.muted },
  values: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "flex-start",
    direction: "ltr",
  },
  valueRow: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    direction: "ltr",
  },
  amountSymbol: { flexShrink: 0, fontFamily: fonts.sansMedium, writingDirection: "ltr" },
  amount: {
    flexShrink: 1,
    maxWidth: "100%",
    fontFamily: fonts.monoBold,
    fontVariant: ["tabular-nums"],
    writingDirection: "ltr",
  },
  currency: {
    fontSize: 13,
    fontFamily: fonts.sansSemi,
    color: board.text,
    writingDirection: "ltr",
    flexShrink: 1,
  },
  track: { height: 2, marginTop: 8, backgroundColor: colors.borderDefault, borderRadius: 1 },
  thumb: { height: 2, backgroundColor: colors.textSubtle, borderRadius: 1 },
});
