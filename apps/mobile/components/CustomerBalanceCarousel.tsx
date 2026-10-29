import { useIsFocused } from "expo-router";
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { useSheetMotionPreference } from "./SheetBackdrop";

const PAGE_GAP = 12;
const PageMotionContext = createContext(true);

/** Offscreen Android copies keep their final layout without animating it. */
export const useCustomerBalancePageMotion = () => useContext(PageMotionContext);

/** Presents existing currency cards without combining or changing their balances. */
export function CustomerBalanceCarousel({
  currencies,
  children,
  active = true,
}: {
  currencies: readonly string[];
  /** Card controls use this callback for activations that don't emit a touch. */
  children: ReactNode | ((onInteract: () => void) => ReactNode);
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
  const scroll = useRef<ScrollViewInstance | null>(null);
  const mounted = useRef(true);
  const selected = useRef({ code: currencies[0] ?? null, index: 0 });
  const [, repaint] = useState(0);
  const nativeDrag = useRef<number | null>(null);
  const automaticScroll = useRef<number | null>(null);
  const dragging = useRef(false);
  const touching = useRef(false);
  const offset = useRef(0);
  const nativeCommand = useRef<{ epoch: number; x: number; animated: boolean } | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleVersion = useRef(0);
  const stopped = useRef(false);
  const timerVersion = useRef(0);
  const [manuallyStopped, setManuallyStopped] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [windowFocused, setWindowFocused] = useState(true);
  // Keep automatic motion off until both native preferences are known.
  const [screenReader, setScreenReader] = useState(true);
  const reducedMotion = useSheetMotionPreference();
  const multiple = currencies.length > 1;
  // Assistive navigation uses only real pages; its controls still wrap.
  const loop = multiple && !screenReader;
  const geometryKey = JSON.stringify([currencies, pageWidth, loop]);
  const geometry = useRef({ key: geometryKey, epoch: 0 });
  if (geometry.current.key !== geometryKey)
    geometry.current = { key: geometryKey, epoch: geometry.current.epoch + 1 };
  const epoch = geometry.current.epoch;
  const pendingAlignment = useRef<number | null>(epoch);
  const pageCount = currencies.length + (loop ? 2 : 0);
  const expectedContentWidth = pageCount * pageWidth + Math.max(0, pageCount - 1) * PAGE_GAP;
  const currentIndex = () => {
    const found = currencies.findIndex((code) => code === selected.current.code);
    return found >= 0
      ? found
      : Math.max(0, Math.min(currencies.length - 1, selected.current.index));
  };
  const index = currentIndex();
  const current = currencies[index];
  const initialOffset = useRef({ epoch: -1, x: 0 });
  if (initialOffset.current.epoch !== epoch) {
    initialOffset.current = { epoch, x: (index + (loop ? 1 : 0)) * step };
    offset.current = initialOffset.current.x;
  }
  const [motionPages, setMotionPages] = useState({ epoch: -1, first: 0, last: 0 });
  const initialPhysical = Math.round(initialOffset.current.x / step);
  const visibleMotionPages =
    motionPages.epoch === epoch ? motionPages : { first: initialPhysical, last: initialPhysical };
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
  const latest = useRef({ epoch, windowWidth, autoAllowed });
  latest.current = { epoch, windowWidth, autoAllowed };
  const isCurrent = () => mounted.current && latest.current.epoch === epoch;
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
  const cancelSettle = () => {
    settleVersion.current++;
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  };
  const physicalIndex = (x: number) => Math.max(0, Math.min(pageCount - 1, Math.round(x / step)));
  const logicalIndex = (physical: number) =>
    loop ? (physical - 1 + currencies.length) % currencies.length : physical;
  const observeMotionOffset = (x: number) => {
    if (Platform.OS !== "android") return;
    const page = x / step;
    const first = Math.max(0, Math.min(pageCount - 1, Math.floor(page)));
    const last = Math.max(first, Math.min(pageCount - 1, Math.ceil(page)));
    setMotionPages((previous) =>
      previous.epoch === epoch && previous.first === first && previous.last === last
        ? previous
        : { epoch, first, last },
    );
  };
  const observeOffset = (x: number) => {
    if (!isCurrent() || !Number.isFinite(x)) return false;
    offset.current = Math.max(0, Math.min((pageCount - 1) * step, x));
    observeMotionOffset(offset.current);
    select(logicalIndex(physicalIndex(offset.current)));
    return true;
  };
  const scrollToPhysical = (physical: number, animated: boolean) => {
    if (!isCurrent()) return;
    cancelSettle();
    const next = physicalIndex(physical * step);
    const x = next * step;
    // Store the command before native code can synchronously acknowledge it.
    nativeCommand.current = { epoch, x, animated };
    offset.current = x;
    if (!animated) {
      observeMotionOffset(x);
      select(logicalIndex(next));
    }
    scroll.current?.scrollTo({ x, animated });
  };
  const scrollToPosition = (position: number, animated: boolean) => {
    if (!currencies.length) return;
    const next = ((position % currencies.length) + currencies.length) % currencies.length;
    scrollToPhysical(next + (loop ? 1 : 0), animated);
  };
  const boundaryPage = (x = offset.current) => {
    if (!loop || !Number.isFinite(x)) return null;
    const physical = physicalIndex(x);
    if (Math.abs(x - physical * step) > 1) return null;
    return physical === 0 ? currencies.length : physical === currencies.length + 1 ? 1 : null;
  };
  const settleBoundary = () => {
    if (!isCurrent() || dragging.current || touching.current) return;
    const target = boundaryPage();
    if (target === null) return;
    nativeDrag.current = null;
    automaticScroll.current = null;
    scrollToPhysical(target, false);
  };
  const queueBoundarySettle = (endX?: number) => {
    cancelSettle();
    if (
      !isCurrent() ||
      dragging.current ||
      touching.current ||
      (endX === undefined ? boundaryPage() === null : !Number.isFinite(endX))
    )
      return;
    const version = settleVersion.current;
    // Slow releases may have no momentum event. Recycle only after native
    // movement has been quiet, never while a finger or glide owns the page.
    settleTimer.current = setTimeout(() => {
      if (!isCurrent() || settleVersion.current !== version) return;
      settleTimer.current = null;
      if (dragging.current || touching.current) return;
      if (endX !== undefined) {
        observeOffset(endX);
        nativeCommand.current = { epoch, x: offset.current, animated: false };
        nativeDrag.current = null;
        automaticScroll.current = null;
      }
      settleBoundary();
    }, 140);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      nativeDrag.current = null;
      automaticScroll.current = null;
      timerVersion.current++;
      cancelSettle();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let readerChanged = false;
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", (value) => {
      readerChanged = true;
      if (alive) setScreenReader(value);
    });
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (alive && !readerChanged) setScreenReader(value);
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
      app.remove();
      blur?.remove();
      focus?.remove();
    };
  }, []);
  useEffect(() => {
    // Epochs retire old native callbacks even when geometry changes A→B→A.
    // The keyed scroller begins on the retained real card before first paint.
    nativeDrag.current = null;
    automaticScroll.current = null;
    dragging.current = false;
    touching.current = false;
    pendingAlignment.current = epoch;
    scrollToPosition(index, false);
    return cancelSettle;
    // Amount-only refreshes must not interrupt the user's native scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);
  useEffect(() => {
    if (
      reducedMotion &&
      nativeCommand.current?.epoch === epoch &&
      nativeCommand.current.animated &&
      !dragging.current &&
      !touching.current
    )
      scrollToPosition(currentIndex(), false);
    // Only cancel programmatic autoplay; a finger keeps native scroll control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, epoch]);
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
        // The trailing first-currency copy keeps the last-to-first step
        // adjacent. A missed native end cannot strand autoplay on a clone.
        settleBoundary();
        automaticScroll.current = epoch;
        pendingAlignment.current = null;
        scrollToPhysical(physicalIndex(offset.current) + 1, true);
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
  }, [autoAllowed, epoch]);
  const eventOffset = (event: ScrollEvent) => {
    if (!isCurrent()) return null;
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    if (!Number.isFinite(contentOffset.x)) return null;
    if (layoutMeasurement?.width > 0 && Math.abs(layoutMeasurement.width - pageWidth) > 2)
      return null;
    if (contentSize?.width > 0 && Math.abs(contentSize.width - expectedContentWidth) > 2)
      return null;
    return Math.max(0, Math.min((pageCount - 1) * step, contentOffset.x));
  };
  const recordScroll = (event: ScrollEvent) => {
    const x = eventOffset(event);
    if (x == null) return;
    if (nativeDrag.current !== epoch && automaticScroll.current !== epoch) {
      const command = nativeCommand.current;
      if (!command || command.epoch !== epoch || Math.abs(x - command.x) > 1) return;
    }
    if (observeOffset(x)) queueBoundarySettle();
  };
  const move = (direction: -1 | 1) => {
    if (!isCurrent()) return;
    stopAutomaticScroll();
    nativeDrag.current = null;
    automaticScroll.current = null;
    scrollToPosition(currentIndex() + direction, false);
  };
  if (!current) return null;
  const cards = Children.toArray(
    typeof children === "function"
      ? children(() => {
          if (isCurrent()) stopAutomaticScroll();
        })
      : children,
  );
  const pages = [
    ...(loop
      ? [
          {
            child: cards[cards.length - 1],
            code: currencies[currencies.length - 1],
            kind: "leading",
          },
        ]
      : []),
    ...cards.map((child, position) => ({ child, code: currencies[position], kind: "real" })),
    ...(loop ? [{ child: cards[0], code: currencies[0], kind: "trailing" }] : []),
  ];
  const thumbWidth = Math.min(pageWidth, Math.max(24, pageWidth / currencies.length));
  return (
    <View
      testID="customer-balance-carousel"
      accessible={false}
      style={styles.carousel}
      onTouchStart={() => {
        if (!isCurrent()) return;
        touching.current = true;
        cancelSettle();
        stopAutomaticScroll();
      }}
      onTouchEnd={() => {
        if (!isCurrent()) return;
        touching.current = false;
        queueBoundarySettle();
      }}
      onTouchCancel={() => {
        if (!isCurrent()) return;
        touching.current = false;
        queueBoundarySettle();
      }}
      onAccessibilityTap={() => {
        if (isCurrent()) stopAutomaticScroll();
      }}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (
          isCurrent() &&
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
        key={epoch}
        ref={scroll}
        contentOffset={{ x: initialOffset.current.x, y: 0 }}
        testID="customer-balance-scroll"
        accessible={false}
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.pages}
        scrollEnabled={multiple}
        showsHorizontalScrollIndicator={false}
        snapToOffsets={pages.map((_, position) => position * step)}
        decelerationRate="fast"
        disableIntervalMomentum
        directionalLockEnabled
        nestedScrollEnabled
        scrollsToTop={false}
        bounces={multiple && !loop}
        overScrollMode={multiple && !loop ? "auto" : "never"}
        keyboardShouldPersistTaps="always"
        onContentSizeChange={(width) => {
          if (
            !isCurrent() ||
            pendingAlignment.current !== epoch ||
            nativeDrag.current === epoch ||
            touching.current ||
            !Number.isFinite(width) ||
            Math.abs(width - expectedContentWidth) > 2
          )
            return;
          // Native scrollTo can clamp against the previous content width.
          // Retry once the new pages exist, never on ordinary height refreshes.
          pendingAlignment.current = null;
          scrollToPosition(currentIndex(), false);
        }}
        onScrollBeginDrag={(event) => {
          if (eventOffset(event) == null) return;
          stopAutomaticScroll();
          dragging.current = true;
          nativeDrag.current = epoch;
          automaticScroll.current = null;
          nativeCommand.current = null;
          pendingAlignment.current = null;
          cancelSettle();
        }}
        onScroll={recordScroll}
        onScrollEndDrag={(event) => {
          const x = eventOffset(event);
          if (x == null) return;
          dragging.current = false;
          touching.current = false;
          if (observeOffset(x)) {
            const velocity = event.nativeEvent.velocity?.x;
            const target = event.nativeEvent.targetContentOffset?.x;
            const stoppedAtEdge =
              Number.isFinite(velocity) &&
              Math.abs(velocity ?? 0) < 0.01 &&
              (!Number.isFinite(target) || Math.abs((target ?? 0) - x) <= 1);
            if (stoppedAtEdge) settleBoundary();
            else queueBoundarySettle();
          }
        }}
        onMomentumScrollBegin={() => {
          if (isCurrent()) cancelSettle();
        }}
        onMomentumScrollEnd={(event) => {
          const x = eventOffset(event);
          if (x == null || dragging.current || touching.current) return;
          // Keep the last loop command as a guard: an older sentinel end can
          // arrive even after the real page acknowledges its recenter.
          const command = nativeCommand.current;
          if (loop && command?.epoch === epoch) {
            if (Math.abs(x - command.x) > 1) return;
          } else if (loop && Math.abs(x - offset.current) > 1) {
            queueBoundarySettle(x);
            return;
          }
          if (
            nativeDrag.current !== epoch &&
            automaticScroll.current !== epoch &&
            logicalIndex(physicalIndex(x)) !== currentIndex()
          )
            stopAutomaticScroll();
          cancelSettle();
          observeOffset(x);
          nativeDrag.current = null;
          automaticScroll.current = null;
          nativeCommand.current = { epoch, x, animated: false };
          // Native assistive scrolling can use viewport width without gaps.
          if (!loop && Math.abs(x - physicalIndex(x) * step) > 2)
            scrollToPhysical(physicalIndex(x), false);
          settleBoundary();
        }}
        scrollEventThrottle={32}
      >
        {pages.map(({ child, code, kind }, position) => (
          <View
            key={`${code ?? position}:${kind}`}
            testID={
              kind === "real"
                ? `customer-balance-page-${code}`
                : `customer-balance-loop-${kind}-${code}`
            }
            accessible={false}
            style={[styles.page, { width: pageWidth }]}
            accessibilityElementsHidden={kind !== "real" || code !== current}
            importantForAccessibility={
              kind === "real" && code === current ? "auto" : "no-hide-descendants"
            }
            pointerEvents={code === current ? "auto" : "none"}
          >
            {Platform.OS === "android" ? (
              <PageMotionContext.Provider
                value={
                  active &&
                  focused &&
                  appState === "active" &&
                  windowFocused &&
                  position >= visibleMotionPages.first &&
                  position <= visibleMotionPages.last
                }
              >
                {child}
              </PageMotionContext.Provider>
            ) : (
              child
            )}
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
          onAccessibilityTap={() => {
            if (isCurrent()) stopAutomaticScroll();
          }}
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
