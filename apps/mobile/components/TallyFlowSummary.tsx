import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol, getCurrencyLabel } from "../lib/currency";
import { rowDir } from "../lib/direction";
import { formatAmount } from "../lib/format";
import { fonts, monoLineHeight, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import type { TallyFlowSummary as FlowSummary } from "../lib/tally-summary";
import { TOUCH_MIN } from "../lib/tokens";
import { useCustomerBalancePageMotion } from "./CustomerBalanceCarousel";
import { useSheetMotionPreference } from "./SheetBackdrop";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export type TallyFlowDirection = "received" | "gave";

/** Confirmed handovers, kept separate from the customer's net balance.
 *  Inline stays within half the balance header; footer uses two columns. */
export function TallyFlowSummary({
  summary,
  isRTL,
  currency: currencyCode,
  variant = "inline",
  filter = "all",
  onDirectionChange,
  interactionEnabled = true,
}: {
  summary: FlowSummary;
  isRTL: boolean;
  currency?: string;
  variant?: "inline" | "footer";
  filter?: "all" | TallyFlowDirection;
  onDirectionChange?: (direction: TallyFlowDirection) => void;
  interactionEnabled?: boolean;
}) {
  const interactive = variant === "footer" && onDirectionChange;
  if (summary.gave.count === 0 && summary.received.count === 0 && !interactive) return null;
  const currency = currencyCode ? getCurrencyLabel(currencyCode) : getCurrentCurrencySymbol();
  if (interactive)
    return (
      <TallyFlowFilterFooter
        summary={summary}
        isRTL={isRTL}
        currency={currency}
        filter={filter}
        onDirectionChange={interactive}
        interactionEnabled={interactionEnabled}
      />
    );
  if (variant === "footer") {
    return (
      <View style={styles.footer}>
        <View style={styles.footerColumns}>
          {(["received", "gave"] as const).map((direction) => {
            const flow = summary[direction];
            const label = t(direction === "gave" ? "person.flows.gave" : "person.flows.received", {
              count: flow.count,
            });
            return (
              <View
                key={direction}
                accessible
                accessibilityLabel={`${label}, ${formatAmount(flow.amount)} ${currency}`}
                accessibilityHint={t("person.flows.hint")}
                style={[
                  styles.footerColumn,
                  direction === "received" ? styles.footerReceived : styles.footerGave,
                ]}
              >
                <Text style={[styles.footerLabel, { writingDirection: isRTL ? "rtl" : "ltr" }]}>
                  {label}
                </Text>
                <Text
                  style={styles.footerAmount}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.1}
                  maxFontSizeMultiplier={1.3}
                >
                  {formatAmount(flow.amount)}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.summary}>
      {(["gave", "received"] as const).map((direction) => {
        const flow = summary[direction];
        // Keep the translated label and parentheses, with Latin digits matching
        // the amounts in every language.
        const label = t(direction === "gave" ? "person.flows.gave" : "person.flows.received", {
          count: flow.count,
        });
        return (
          <View
            key={direction}
            accessible
            accessibilityLabel={`${label}, ${formatAmount(flow.amount)} ${currency}`}
            // On each row: a hint on the non-accessible container was never read.
            accessibilityHint={t("person.flows.hint")}
            style={[styles.line, rowDir(isRTL)]}
          >
            <Text
              style={[styles.label, { writingDirection: isRTL ? "rtl" : "ltr" }]}
              numberOfLines={1}
            >
              {label}
            </Text>
            <Text
              style={styles.amount}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {formatAmount(flow.amount)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function TallyFlowFilterFooter({
  summary,
  isRTL,
  currency,
  filter,
  onDirectionChange,
  interactionEnabled,
}: {
  summary: FlowSummary;
  isRTL: boolean;
  currency: string;
  filter: "all" | TallyFlowDirection;
  onDirectionChange: (direction: TallyFlowDirection) => void;
  interactionEnabled: boolean;
}) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const reducedMotion = useSheetMotionPreference();
  const animationEnabled = useCustomerBalancePageMotion();
  const [measurement, setMeasurement] = useState({ windowWidth, width: 0 });
  const width = Math.max(
    0,
    measurement.windowWidth === windowWidth && measurement.width > 0
      ? measurement.width
      : windowWidth - 34,
  );
  const compactWidth = Math.min(width / 2, Math.max(TOUCH_MIN, fontScale > 1.3 ? 104 : 80));
  const targetReceivedWidth =
    filter === "received" ? width - compactWidth : filter === "gave" ? compactWidth : width / 2;
  const receivedWidth = useSharedValue(targetReceivedWidth);
  const receivedStyle = useAnimatedStyle(() => ({
    width: Math.max(0, Math.min(width, receivedWidth.value)),
  }));
  const gaveStyle = useAnimatedStyle(() => ({
    width: Math.max(0, width - receivedWidth.value),
  }));
  const previousLayout = useRef({ width, targetReceivedWidth });
  const mounted = useRef(true);
  const latest = useRef({ windowWidth, interactionEnabled });
  latest.current = { windowWidth, interactionEnabled };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const resized = previousLayout.current.width !== width;
    const changed = previousLayout.current.targetReceivedWidth !== targetReceivedWidth;
    previousLayout.current = { width, targetReceivedWidth };
    // Compare requested targets on JS; reading the UI value here can block it.
    if (!resized && !changed && animationEnabled && !reducedMotion) return;
    receivedWidth.value =
      reducedMotion || resized || !animationEnabled
        ? targetReceivedWidth
        : withTiming(targetReceivedWidth, { duration: 200, reduceMotion: ReduceMotion.System });
  }, [width, targetReceivedWidth, receivedWidth, reducedMotion, animationEnabled]);
  return (
    <View
      testID="tally-flow-filter-footer"
      style={[styles.footer, styles.interactiveFooter]}
      onLayout={(event) => {
        const measured = event.nativeEvent.layout.width;
        if (
          mounted.current &&
          latest.current.windowWidth === windowWidth &&
          Number.isFinite(measured) &&
          measured > 0
        )
          setMeasurement((previous) =>
            previous.windowWidth === windowWidth && previous.width === measured
              ? previous
              : { windowWidth, width: measured },
          );
      }}
    >
      <View style={styles.footerColumns}>
        {(["received", "gave"] as const).map((direction) => {
          const flow = summary[direction];
          const selected = filter === direction;
          const compact = filter !== "all" && !selected;
          const received = direction === "received";
          const targetWidth = received ? targetReceivedWidth : width - targetReceivedWidth;
          // Text fits its final lane once. Measuring it against every animated
          // button width makes native auto-fit repeatedly shrink/grow glyphs.
          const contentWidth = Math.max(0, targetWidth - (compact ? 12 : 24) - (received ? 0 : 1));
          const tone = received ? colors.entryActionReceivedText : colors.payStrong;
          const label = t(received ? "person.flows.received" : "person.flows.gave", {
            count: flow.count,
          });
          return (
            <AnimatedPressable
              key={direction}
              testID={`tally-flow-filter-${direction}`}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${label}, ${formatAmount(flow.amount)} ${currency}`}
              accessibilityHint={
                selected ? t("customers.balanceFilter.clear") : t("person.flows.hint")
              }
              accessibilityState={{ selected, disabled: !interactionEnabled }}
              disabled={!interactionEnabled}
              onPress={() => {
                if (mounted.current && latest.current.interactionEnabled)
                  onDirectionChange(direction);
              }}
              style={[
                styles.flowButton,
                !received && styles.flowButtonGave,
                compact && styles.compactFlowButton,
                selected && {
                  backgroundColor: received ? colors.entryActionReceived : colors.payBg,
                },
                !interactionEnabled && styles.disabledFlowButton,
                received ? receivedStyle : gaveStyle,
              ]}
            >
              <View
                testID={`tally-flow-content-${direction}`}
                style={[
                  styles.flowContent,
                  { width: contentWidth, alignSelf: received ? "flex-start" : "flex-end" },
                ]}
              >
                <View style={[styles.flowHeading, compact && styles.compactFlowHeading]}>
                  <Ionicons
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    name={received ? "arrow-down-outline" : "arrow-up-outline"}
                    size={compact ? 18 : 12}
                    color={tone}
                  />
                  <Text
                    testID={`tally-flow-label-${direction}`}
                    accessible={false}
                    numberOfLines={compact ? 2 : 1}
                    adjustsFontSizeToFit
                    maxFontSizeMultiplier={1.3}
                    style={[
                      styles.footerLabel,
                      styles.flowButtonLabel,
                      { writingDirection: isRTL ? "rtl" : "ltr" },
                      compact && styles.compactFlowLabel,
                      selected && { color: tone },
                    ]}
                  >
                    {compact
                      ? t(received ? "person.action.iReceived" : "person.action.iGave")
                      : label}
                  </Text>
                </View>
                {!compact ? (
                  <Text
                    accessible={false}
                    style={[styles.footerAmount, selected && { color: tone }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.1}
                    maxFontSizeMultiplier={1.3}
                  >
                    {formatAmount(flow.amount)}
                  </Text>
                ) : null}
              </View>
            </AnimatedPressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Content-sized up to half the row, so a large balance keeps its room.
  summary: { flexShrink: 1, maxWidth: "50%", minWidth: 0, justifyContent: "center", gap: 6 },
  line: { alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  label: {
    flexShrink: 1,
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.textSubtle,
  },
  amount: {
    flexShrink: 0,
    fontFamily: fonts.monoMedium,
    fontSize: 15,
    lineHeight: monoLineHeight(15, 20),
    color: colors.textEmphasis,
  },
  footer: {
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  footerColumns: { direction: "ltr", flexDirection: "row", alignItems: "stretch" },
  interactiveFooter: { paddingHorizontal: 0, paddingVertical: 0, gap: 0 },
  flowButton: {
    flexShrink: 0,
    minWidth: 0,
    minHeight: 66,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: "center",
    overflow: "hidden",
  },
  flowContent: { flexShrink: 0, gap: 4 },
  flowButtonGave: { borderLeftWidth: 1, borderLeftColor: colors.borderDefault },
  flowHeading: { flexDirection: "row", direction: "ltr", alignItems: "center", gap: 5 },
  flowButtonLabel: { flex: 1, minWidth: 0 },
  compactFlowButton: { paddingHorizontal: 6, alignItems: "center" },
  compactFlowHeading: { flexDirection: "column", gap: 4, maxWidth: "100%" },
  compactFlowLabel: { flex: 0, textAlign: "center", color: colors.textDefault },
  disabledFlowButton: { opacity: 0.55 },
  footerColumn: { flex: 1, minWidth: 0, gap: 4 },
  footerReceived: { paddingRight: 14 },
  footerGave: { paddingLeft: 14, borderLeftWidth: 1, borderLeftColor: colors.borderDefault },
  footerLabel: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.textSubtle,
    textAlign: "left",
  },
  footerAmount: {
    width: "100%",
    minWidth: 0,
    fontFamily: fonts.monoMedium,
    fontSize: 15,
    lineHeight: monoLineHeight(15, 20),
    color: colors.textEmphasis,
    writingDirection: "ltr",
    textAlign: "left",
  },
});
