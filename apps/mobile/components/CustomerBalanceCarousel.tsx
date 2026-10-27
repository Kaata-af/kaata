import { useIsFocused } from "expo-router";
import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ScrollEvent,
  type ScrollViewInstance,
} from "react-native";
import { colors } from "../lib/colors";
import { getCurrencyLabel } from "../lib/currency";
import { useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";

const PAGE_GAP = 12;

/** Presents existing currency cards without combining or changing their balances. */
export function CustomerBalanceCarousel({
  currencies,
  children,
  active = true,
}: {
  currencies: readonly string[];
  children: ReactNode;
  active?: boolean;
}) {
  // Subscribe to label-language changes while keeping the physical pages LTR.
  useIsRTL();
  const focused = useIsFocused();
  const { width: windowWidth } = useWindowDimensions();
  const [measurement, setMeasurement] = useState({ windowWidth, width: 0 });
  const pageWidth = Math.max(
    1,
    measurement.windowWidth === windowWidth && measurement.width > 0
      ? measurement.width
      : windowWidth - 32,
  );
  const step = pageWidth + PAGE_GAP;
  const geometry = JSON.stringify([currencies, pageWidth]);
  const scroll = useRef<ScrollViewInstance | null>(null);
  const mounted = useRef(true);
  const selected = useRef({ code: currencies[0] ?? null, index: 0 });
  const [, repaint] = useState(0);
  const nativeDrag = useRef<string | null>(null);
  const automaticScroll = useRef<string | null>(null);
  const automaticDirection = useRef(1);
  const stopped = useRef(false);
  const timerVersion = useRef(0);
  const [manuallyStopped, setManuallyStopped] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [windowFocused, setWindowFocused] = useState(true);
  // Keep automatic motion off until both native preferences are known.
  const [screenReader, setScreenReader] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);
  const pendingAlignment = useRef<string | null>(geometry);
  const expectedContentWidth =
    currencies.length * pageWidth + Math.max(0, currencies.length - 1) * PAGE_GAP;
  const currentIndex = () => {
    const found = currencies.findIndex((code) => code === selected.current.code);
    return found >= 0
      ? found
      : Math.max(0, Math.min(currencies.length - 1, selected.current.index));
  };
  const index = currentIndex();
  const current = currencies[index];
  const multiple = currencies.length > 1;
  const autoAllowed =
    active &&
    focused &&
    appState === "active" &&
    windowFocused &&
    !screenReader &&
    !reducedMotion &&
    !manuallyStopped &&
    multiple &&
    measurement.windowWidth === windowWidth &&
    measurement.width > 0;
  const latest = useRef({ geometry, windowWidth, autoAllowed });
  latest.current = { geometry, windowWidth, autoAllowed };
  const isCurrent = () => mounted.current && latest.current.geometry === geometry;
  const stopAutomaticScroll = () => {
    if (!mounted.current) return;
    // The ref and version close the gap before React commits the stop state.
    stopped.current = true;
    timerVersion.current++;
    setManuallyStopped(true);
  };
  const select = (next: number) => {
    const bounded = Math.max(0, Math.min(currencies.length - 1, next));
    const code = currencies[bounded];
    if (code == null) return;
    if (selected.current.code !== code || selected.current.index !== bounded) {
      selected.current = { code, index: bounded };
      repaint((revision) => revision + 1);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      nativeDrag.current = null;
      automaticScroll.current = null;
      timerVersion.current++;
    };
  }, []);
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
  useEffect(() => {
    // A new geometry ends any old drag. Its queued native events cannot
    // override the preserved currency after this nonanimated alignment.
    nativeDrag.current = null;
    automaticScroll.current = null;
    pendingAlignment.current = geometry;
    select(index);
    scroll.current?.scrollTo({ x: index * step, animated: false });
    // Amount-only refreshes must not interrupt the user's native scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry]);
  useEffect(() => {
    const version = ++timerVersion.current;
    if (!autoAllowed) return;
    let timer: ReturnType<typeof setTimeout>;
    const queue = () => {
      timer = setTimeout(() => {
        if (
          !isCurrent() ||
          version !== timerVersion.current ||
          stopped.current ||
          !latest.current.autoAllowed ||
          !scroll.current
        )
          return;
        let next = currentIndex() + automaticDirection.current;
        if (next >= currencies.length || next < 0) {
          automaticDirection.current *= -1;
          next = currentIndex() + automaticDirection.current;
        }
        // Native events track the visible page during the animation.
        automaticScroll.current = geometry;
        scroll.current.scrollTo({ x: next * step, animated: true });
        queue();
      }, 5000);
    };
    queue();
    return () => {
      timerVersion.current++;
      clearTimeout(timer);
    };
    // Balance refreshes keep both the cadence and the permanent manual stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAllowed, geometry]);
  const eventOffset = (event: ScrollEvent) => {
    if (!isCurrent()) return null;
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    if (!Number.isFinite(contentOffset.x)) return null;
    if (layoutMeasurement?.width > 0 && Math.abs(layoutMeasurement.width - pageWidth) > 2)
      return null;
    if (contentSize?.width > 0 && Math.abs(contentSize.width - expectedContentWidth) > 2)
      return null;
    return Math.max(0, Math.min((currencies.length - 1) * step, contentOffset.x));
  };
  const recordScroll = (event: ScrollEvent, settled = false) => {
    const x = eventOffset(event);
    if (x == null) return;
    const nearest = Math.round(x / step);
    // Native accessibility and hardware-key scrolling can settle without a
    // touch drag. Accept their settled page, while ignoring intermediate
    // events from nonanimated layout alignment and old native momentum.
    if (nativeDrag.current !== geometry && automaticScroll.current !== geometry && !settled) return;
    if (
      settled &&
      nativeDrag.current !== geometry &&
      automaticScroll.current !== geometry &&
      nearest !== currentIndex()
    )
      stopAutomaticScroll();
    select(nearest);
    // An accessibility page command can move by viewport width without the
    // gap. Align its final page to the same absolute targets as native drags.
    if (settled && Math.abs(x - nearest * step) > 2)
      scroll.current?.scrollTo({ x: nearest * step, animated: false });
  };
  const move = (direction: -1 | 1) => {
    stopAutomaticScroll();
    if (!isCurrent()) return;
    const previous = currentIndex();
    const next = Math.max(0, Math.min(currencies.length - 1, previous + direction));
    if (next === previous) return;
    nativeDrag.current = null;
    automaticScroll.current = null;
    select(next);
    scroll.current?.scrollTo({ x: next * step, animated: false });
  };
  if (!current) return null;
  const thumbWidth = Math.min(pageWidth, Math.max(24, pageWidth / currencies.length));
  return (
    <View
      testID="customer-balance-carousel"
      accessible={false}
      style={styles.carousel}
      onTouchStart={stopAutomaticScroll}
      onAccessibilityTap={stopAutomaticScroll}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (
          mounted.current &&
          latest.current.windowWidth === windowWidth &&
          Number.isFinite(width) &&
          width > 0
        )
          setMeasurement((previous) =>
            previous.windowWidth === windowWidth && previous.width === width
              ? previous
              : { windowWidth, width },
          );
      }}
    >
      <ScrollView
        ref={scroll}
        testID="customer-balance-scroll"
        accessible={false}
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.pages}
        scrollEnabled={multiple}
        showsHorizontalScrollIndicator={false}
        snapToOffsets={currencies.map((_, position) => position * step)}
        decelerationRate="fast"
        disableIntervalMomentum
        directionalLockEnabled
        nestedScrollEnabled
        scrollsToTop={false}
        bounces={multiple}
        overScrollMode={multiple ? "auto" : "never"}
        keyboardShouldPersistTaps="always"
        onContentSizeChange={(width) => {
          if (
            !isCurrent() ||
            pendingAlignment.current !== geometry ||
            nativeDrag.current === geometry ||
            !Number.isFinite(width) ||
            Math.abs(width - expectedContentWidth) > 2
          )
            return;
          // Native scrollTo can clamp against the previous content width.
          // Retry once the new pages exist, never on ordinary height refreshes.
          pendingAlignment.current = null;
          scroll.current?.scrollTo({ x: currentIndex() * step, animated: false });
        }}
        onScrollBeginDrag={(event) => {
          stopAutomaticScroll();
          if (eventOffset(event) != null) {
            nativeDrag.current = geometry;
            automaticScroll.current = null;
            pendingAlignment.current = null;
          }
        }}
        onScroll={recordScroll}
        onScrollEndDrag={recordScroll}
        onMomentumScrollEnd={(event) => {
          recordScroll(event, true);
          if (isCurrent()) {
            nativeDrag.current = null;
            automaticScroll.current = null;
          }
        }}
        scrollEventThrottle={32}
      >
        {Children.toArray(children).map((child, position) => (
          <View
            key={currencies[position] ?? position}
            testID={`customer-balance-page-${currencies[position]}`}
            accessible={false}
            style={[styles.page, { width: pageWidth }]}
            accessibilityElementsHidden={position !== index}
            importantForAccessibility={position === index ? "auto" : "no-hide-descendants"}
            pointerEvents={position === index ? "auto" : "none"}
          >
            {child}
          </View>
        ))}
      </ScrollView>
      {multiple ? (
        <View
          testID="customer-balance-indicator"
          style={styles.track}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={getCurrencyLabel(current)}
          accessibilityValue={{ min: 1, max: currencies.length, now: index + 1 }}
          accessibilityActions={[
            { name: "increment", label: t("home.total.nextCurrency") },
            { name: "decrement", label: t("home.total.previousCurrency") },
          ]}
          onAccessibilityTap={stopAutomaticScroll}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "increment") move(1);
            else if (event.nativeEvent.actionName === "decrement") move(-1);
          }}
        >
          <View
            testID="customer-balance-thumb"
            accessible={false}
            style={[
              styles.thumb,
              {
                width: thumbWidth,
                transform: [
                  { translateX: ((pageWidth - thumbWidth) * index) / (currencies.length - 1) },
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
  carousel: { width: "100%", direction: "ltr" },
  scroll: { flexGrow: 0, flexShrink: 0, direction: "ltr" },
  // One row takes the tallest card's natural height, rather than adding pages.
  pages: { flexDirection: "row", alignItems: "stretch", gap: PAGE_GAP, direction: "ltr" },
  page: { flexGrow: 0, flexShrink: 0, minWidth: 0, alignItems: "stretch" },
  track: { height: 2, marginTop: 8, backgroundColor: colors.borderDefault, borderRadius: 1 },
  thumb: { height: 2, backgroundColor: colors.textSubtle, borderRadius: 1 },
});
