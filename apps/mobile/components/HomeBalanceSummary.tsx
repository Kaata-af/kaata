import { Ionicons } from "@expo/vector-icons";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ScrollViewInstance,
} from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencyCode, getCurrencyLabel } from "../lib/currency";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import { t } from "../lib/i18n";
import { currencyBalances } from "../lib/multi-currency-view";
import type { PersonWithBalance } from "../lib/types";

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

/** A currency always shows both sides together, without growing the sticky
 * header as more currencies are added. Native scrolling owns the animation. */
export function HomeBalanceSummary({
  people,
  balances,
  currency = getCurrentCurrencyCode(),
  compact = false,
  active = true,
}: {
  people: readonly PersonWithBalance[];
  balances?: readonly HomeCurrencyBalance[];
  currency?: string;
  compact?: boolean;
  active?: boolean;
}) {
  const isRTL = useIsRTL();
  const focused = useIsFocused();
  const { height, width, fontScale = 1 } = useWindowDimensions();
  const small = compact || height < 500;
  const rows = visibleCurrencyBalances(balances ?? currencyBalances(people, currency), currency);
  const codes = JSON.stringify(rows.map((row) => row.currency));
  const scroll = useRef<ScrollViewInstance | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const viewport = measuredWidth || Math.max(0, width - 32);
  const multiple = rows.length > 1;
  const pageWidth = Math.max(0, viewport);
  const step = pageWidth + 12;
  const cardHeight = small ? (fontScale > 1.3 ? 114 : 104) : fontScale > 1.3 ? 144 : 132;
  const amountWidth = Math.max(1, pageWidth / 2 - (small ? 18 : 26));
  const [position, setPosition] = useState(0);
  const selectedCode = useRef(rows[0].currency);
  const offset = useRef(0);
  const direction = useRef(1);
  const stopped = useRef(false);
  const [manuallyStopped, setManuallyStopped] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [windowFocused, setWindowFocused] = useState(true);
  // Wait for both queries before starting motion. An initial async response
  // must not overwrite a preference changed while that query was in flight.
  const [screenReader, setScreenReader] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);
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
    !screenReader &&
    !reducedMotion &&
    !manuallyStopped &&
    multiple &&
    measuredWidth > 0;
  const latest = useRef({ autoAllowed, codes, step });
  latest.current = { autoAllowed, codes, step };
  const mounted = useRef(true);
  const timerVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      timerVersion.current++;
    };
  }, []);
  const stopAutomaticScroll = () => {
    if (!mounted.current) return;
    stopped.current = true;
    setManuallyStopped(true);
  };
  const scrollToPosition = (index: number, animated: boolean) => {
    if (!mounted.current || latest.current.codes !== codes || latest.current.step !== step) return;
    const next = Math.max(0, Math.min(rows.length - 1, index));
    offset.current = next * step;
    selectedCode.current = rows[next].currency;
    // Animated positions follow native scroll events; setting the target now
    // would make the marker jump forward, back, then forward during the move.
    if (!animated) setPosition(next);
    scroll.current?.scrollTo({ x: offset.current, animated });
  };
  // Amount refreshes retain the user's currency. Rotation and currency removal
  // align the same currency (or nearest survivor) without animating old bounds.
  useEffect(() => {
    const selected = rows.findIndex((row) => row.currency === selectedCode.current);
    scrollToPosition(selected < 0 ? position : selected, false);
    // The values themselves never reset manual control or the native offset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes, step]);
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
          latest.current.codes !== codes ||
          latest.current.step !== step ||
          !scroll.current
        )
          return;
        const current = Math.max(0, Math.min(rows.length - 1, Math.round(offset.current / step)));
        let next = current + direction.current;
        if (next >= rows.length || next < 0) {
          direction.current *= -1;
          next = current + direction.current;
        }
        scrollToPosition(next, true);
        queue();
      }, 5000);
    };
    queue();
    return () => {
      timerVersion.current++;
      clearTimeout(timer);
    };
    // Each turn is adjacent; reverse at the end instead of sweeping through
    // every currency to return to the first one. A refresh does not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAllowed, codes, step]);
  const shownPosition = Math.min(position, rows.length - 1);
  const current = rows[shownPosition];
  const summaryLabel = current.pending
    ? `${getCurrencyLabel(current.currency)}, ${t("home.total.pending")}`
    : `${getCurrencyLabel(current.currency)}, ${t("home.total.label.collect")}: ${formatAmount(current.collect)}, ${t("home.total.label.pay")}: ${formatAmount(current.pay)}`;
  const thumbWidth = Math.min(viewport, Math.max(24, viewport / rows.length));
  return (
    <View
      style={[styles.summary, small && styles.compactSummary]}
      onTouchStart={stopAutomaticScroll}
      accessible
      accessibilityRole={multiple ? "adjustable" : undefined}
      accessibilityLabel={summaryLabel}
      accessibilityValue={
        multiple ? { min: 1, max: rows.length, now: shownPosition + 1 } : undefined
      }
      accessibilityActions={
        multiple
          ? [
              { name: "increment", label: t("home.total.nextCurrency") },
              { name: "decrement", label: t("home.total.previousCurrency") },
            ]
          : undefined
      }
      onAccessibilityTap={stopAutomaticScroll}
      onAccessibilityAction={(event) => {
        stopAutomaticScroll();
        if (event.nativeEvent.actionName === "increment")
          scrollToPosition(shownPosition + 1, false);
        else if (event.nativeEvent.actionName === "decrement")
          scrollToPosition(shownPosition - 1, false);
      }}
    >
      <ScrollView
        ref={scroll}
        horizontal
        accessible={false}
        style={{ height: cardHeight, flexGrow: 0, direction: "ltr" }}
        contentContainerStyle={{ gap: 12, direction: "ltr" }}
        scrollEnabled={multiple}
        showsHorizontalScrollIndicator={false}
        // Absolute targets avoid accumulated interval rounding on Android
        // phones whose density turns the inter-card gap into half a pixel.
        snapToOffsets={rows.map((_, index) => index * step)}
        decelerationRate="fast"
        bounces={multiple}
        overScrollMode={multiple ? "auto" : "never"}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.width;
          if (mounted.current && Number.isFinite(next) && next > 0) setMeasuredWidth(next);
        }}
        onScrollBeginDrag={stopAutomaticScroll}
        onScroll={(event) => {
          if (!mounted.current || latest.current.codes !== codes || latest.current.step !== step)
            return;
          const x = event.nativeEvent.contentOffset.x;
          offset.current = Math.max(0, x);
          const next = Math.max(0, Math.min(rows.length - 1, Math.round(offset.current / step)));
          selectedCode.current = rows[next].currency;
          setPosition(next);
        }}
        scrollEventThrottle={64}
        keyboardShouldPersistTaps="always"
      >
        {rows.map((row) => (
          <View
            key={row.currency}
            testID={`home-balance-${row.currency}`}
            style={[styles.page, { width: pageWidth, height: cardHeight }]}
          >
            <View style={[styles.boardHeader, small && styles.compactHeader]}>
              <Text
                testID={`home-balance-currency-${row.currency}`}
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
            <View style={styles.quoteRow}>
              {(["collect", "pay"] as const).map((side) => {
                const collect = side === "collect";
                const tone = collect ? board.collect : board.pay;
                const amount = row.pending ? "…" : formatAmount(row[side]);
                const amountSize = amount.length > 10 ? (small ? 16 : 18) : small ? 20 : 30;
                // Keep every digit even at the largest supported money values.
                // Mono glyphs use about 0.6em; leave headroom for scaled fonts.
                const minimumScale = Math.min(
                  0.5,
                  Math.max(
                    0.01,
                    amountWidth /
                      (amount.length * amountSize * 0.65 * Math.max(1, Math.min(fontScale, 1.2))),
                  ),
                );
                return (
                  <View
                    key={side}
                    testID={`home-balance-${side}-${row.currency}`}
                    style={[styles.card, !collect && styles.payCard, small && styles.compactCard]}
                  >
                    <View style={styles.heading}>
                      <Ionicons
                        name={collect ? "arrow-down-outline" : "arrow-up-outline"}
                        size={12}
                        color={tone}
                      />
                      <Text
                        accessible={false}
                        style={[styles.label, textDir(isRTL)]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        maxFontSizeMultiplier={1.3}
                      >
                        {t(collect ? "home.total.label.collect" : "home.total.label.pay")}
                      </Text>
                    </View>
                    <View style={styles.values}>
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
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
      {multiple ? (
        <View style={styles.track} accessible={false}>
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
  card: { flex: 1, minWidth: 0, paddingHorizontal: 12, paddingVertical: 10 },
  payCard: { borderLeftWidth: 1, borderLeftColor: board.rule },
  compactCard: { paddingHorizontal: 8, paddingVertical: 6 },
  heading: { flexDirection: "row", alignItems: "center", gap: 5, direction: "ltr" },
  label: { flex: 1, fontSize: 11, fontFamily: fonts.sansMedium, color: board.muted },
  values: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "flex-start",
    direction: "ltr",
  },
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
