import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { colors } from "../lib/colors";
import { calculationOperand, evaluateCalculation } from "../lib/calculator";
import {
  calculatorDraft,
  calculatorKey,
  recallCalculationValue,
  type CalculatorDraft,
  type CalculatorRecord,
} from "../lib/calculator-input";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts, monoLineHeight, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import { radius, TOUCH_MIN } from "../lib/tokens";

type Props = {
  draft: CalculatorDraft;
  // Read synchronously so consecutive taps never depend on a React repaint.
  getDraft: () => CalculatorDraft;
  onChange: (draft: CalculatorDraft) => void;
  history: CalculatorRecord[];
  onRecord: (record: CalculatorRecord) => void;
  onClearHistory: () => void;
  onNext: () => void;
  disabled?: boolean;
  visible?: boolean;
  /** Space below the screen header and safe-area insets, including the form. */
  availableHeight?: number;
  /** Measured Save bar, including its padding and border. */
  footerHeight?: number;
};
const LABELS = {
  AC: "calculator.clear",
  delete: "calculator.delete",
  "%": "calculator.percent",
  "/": "calculator.divide",
  "*": "calculator.multiply",
  "-": "calculator.subtract",
  "+": "calculator.add",
  "=": "calculator.equals",
  ".": "calculator.decimal",
  "()": "calculator.parentheses",
  sign: "calculator.sign",
  MC: "calculator.memoryClear",
  MR: "calculator.memoryRecall",
  "M+": "calculator.memoryAdd",
  "M−": "calculator.memorySubtract",
} as const;
const GLYPHS: Record<string, string> = { "/": "÷", "*": "×", "-": "−", sign: "+/−", "()": "( )" };
const KEY_GAP = 5;
export const prettyCalculation = (expression: string) =>
  expression.replace(/\*/g, "×").replace(/\//g, "÷").replace(/-/g, "−");

// This is the amount field's keyboard, not another screen. The parent keeps it
// mounted while Note is focused so memory/history survive switching fields.
export function EntryCalculator(props: Props) {
  const isRTL = useIsRTL();
  const { height, fontScale = 1 } = useWindowDimensions();
  const [memory, setMemory] = useState<string | null>(null);
  const memoryRef = useRef<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [measuredToolsHeight, setMeasuredToolsHeight] = useState(TOUCH_MIN);
  const [feedbackMeasurement, setFeedbackMeasurement] = useState<{
    message: string;
    height: number;
  } | null>(null);
  const alive = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const canEdit = () =>
    alive.current && !latest.current.disabled && latest.current.visible !== false;
  const keyHeight = Math.max(
    TOUCH_MIN,
    Math.ceil(monoLineHeight(22, 29) * fontScale) + 10,
    Math.min(52, height * 0.062),
  );
  // Use the real space left after the header, safe area and Save bar. Until
  // those measurements arrive, leave a conservative allowance for the chrome.
  // Short screens scroll the keys rather than shrink their touch targets.
  const availableHeight =
    Number.isFinite(props.availableHeight) && (props.availableHeight ?? 0) > 0
      ? props.availableHeight!
      : Math.max(0, height - 120);
  const footerHeight =
    Number.isFinite(props.footerHeight) && (props.footerHeight ?? 0) > 0 ? props.footerHeight! : 65;
  const toolsHeight = Math.max(
    TOUCH_MIN,
    measuredToolsHeight,
    Math.ceil(monoLineHeight(13, 20) * fontScale),
  );
  const feedbackHeight = commandError
    ? feedbackMeasurement?.message === commandError
      ? feedbackMeasurement.height
      : Math.ceil(sansLineHeight(12, 18) * fontScale) + 6
    : 0;
  const remainingHeight = availableHeight - footerHeight - toolsHeight - feedbackHeight - 1;
  const formReserve = Math.max(80, Math.min(160, remainingHeight * 0.45));
  const naturalKeysHeight = keyHeight * 6 + KEY_GAP * 5 + 8;
  const panelHeight = Math.min(
    naturalKeysHeight,
    Math.max(TOUCH_MIN, remainingHeight - formReserve),
  );
  const change = (next: CalculatorDraft) => {
    if (!canEdit()) return;
    props.onChange(next);
    setCommandError(null);
  };
  const press = (key: string) => {
    if (!canEdit()) return;
    if (key === "MC") {
      memoryRef.current = null;
      setMemory(null);
      setCommandError(null);
      return;
    }
    if (key === "MR") {
      if (memoryRef.current === null) setCommandError(t("calculator.memoryEmpty"));
      else change(recallCalculationValue(props.getDraft(), memoryRef.current));
      return;
    }
    if (key === "M+" || key === "M−") {
      const current = evaluateCalculation(props.getDraft().expression);
      if (current.status !== "valid") return;
      const next = evaluateCalculation(
        `(${memoryRef.current ?? "0"})${key === "M+" ? "+" : "-"}(${calculationOperand(current)})`,
      );
      if (next.status !== "valid") {
        setCommandError(t("calculator.tooLarge"));
        return;
      }
      const operand = calculationOperand(next);
      if (evaluateCalculation(operand).status !== "valid") {
        setCommandError(t("calculator.tooLarge"));
        return;
      }
      memoryRef.current = operand;
      setMemory(operand);
      setCommandError(null);
      return;
    }
    const current = props.getDraft();
    const next = calculatorKey(current, key);
    if (key === "=") {
      const result = evaluateCalculation(next.expression);
      if (result.status === "valid")
        props.onRecord({ expression: next.expression, result: result.value });
    }
    change(next);
  };
  const key = (value: string) => (
    <Pressable
      key={value}
      accessibilityRole="button"
      accessibilityLabel={value in LABELS ? t(LABELS[value as keyof typeof LABELS]) : value}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={() => press(value)}
      onLongPress={value === "delete" ? () => press("AC") : undefined}
      style={({ pressed }) => [
        styles.key,
        { minHeight: keyHeight },
        /[+*/\-]/.test(value) && styles.operatorKey,
        ["AC", "M+", "M−", "delete", "%"].includes(value) && styles.utilityKey,
        value === "=" && styles.equalsKey,
        pressed && styles.pressed,
      ]}
    >
      {value === "delete" ? (
        <Ionicons name="backspace-outline" size={24} color={colors.textEmphasis} />
      ) : (
        <Text
          style={[
            styles.keyText,
            value === "=" && styles.equalsText,
            ["AC", "M+", "M−"].includes(value) && styles.smallKeyText,
          ]}
        >
          {GLYPHS[value] ?? value}
        </Text>
      )}
    </Pressable>
  );
  if (props.visible === false) return null;
  return (
    <View style={styles.keyboard}>
      <View
        style={styles.tools}
        onLayout={(event) => {
          const nextHeight = event.nativeEvent.layout.height;
          if (alive.current && Number.isFinite(nextHeight) && nextHeight > 0)
            setMeasuredToolsHeight(nextHeight);
        }}
      >
        {["()", "sign", "MC", "MR"].map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={t(LABELS[value as keyof typeof LABELS])}
            disabled={props.disabled}
            onPress={() => press(value)}
            style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
          >
            <Text style={[styles.toolText, value === "MR" && memory !== null && styles.memorySet]}>
              {GLYPHS[value] ?? value}
              {value === "MR" && memory !== null ? " •" : ""}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(historyOpen ? "calculator.backToCalculator" : "calculator.history")}
          disabled={props.disabled}
          onPress={() => {
            if (canEdit()) setHistoryOpen((value) => !value);
          }}
          style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
        >
          <Ionicons
            name={historyOpen ? "calculator-outline" : "time-outline"}
            size={21}
            color={colors.textSubtle}
          />
        </Pressable>
      </View>
      {commandError ? (
        <Text
          style={[styles.feedback, styles.contentWidth, textDir(isRTL)]}
          accessibilityLiveRegion="polite"
          onLayout={(event) => {
            const nextHeight = event.nativeEvent.layout.height;
            if (alive.current && Number.isFinite(nextHeight) && nextHeight > 0)
              setFeedbackMeasurement({ message: commandError, height: nextHeight });
          }}
        >
          {commandError}
        </Text>
      ) : null}
      <ScrollView
        // Keep the expression and total visible on short phones. Keys retain
        // their touch size; this panel scrolls when six rows cannot fit.
        style={[styles.contentWidth, { maxHeight: panelHeight }]}
        contentContainerStyle={styles.keys}
        keyboardShouldPersistTaps="always"
        bounces={false}
      >
        {historyOpen ? (
          <View style={[styles.history, { minHeight: Math.max(0, panelHeight - 8) }]}>
            <Text style={[styles.historyTitle, textDir(isRTL)]}>
              {t("calculator.historyTitle")}
            </Text>
            {props.history.length === 0 ? (
              <Text style={[styles.feedback, textDir(isRTL)]}>{t("calculator.historyEmpty")}</Text>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("calculator.clearHistory")}
                  disabled={props.disabled}
                  style={styles.clearHistory}
                  onPress={() => {
                    if (canEdit()) props.onClearHistory();
                  }}
                >
                  <Text style={[styles.toolText, textDir(isRTL)]}>
                    {t("calculator.clearHistory")}
                  </Text>
                </Pressable>
                {props.history.map((record, index) => (
                  <Pressable
                    key={`${index}:${record.expression}`}
                    accessibilityRole="button"
                    accessibilityLabel={t("calculator.recallCalculation", {
                      expression: prettyCalculation(record.expression),
                    })}
                    disabled={props.disabled}
                    onPress={() => {
                      if (!canEdit()) return;
                      change(calculatorDraft(record.expression));
                      setHistoryOpen(false);
                    }}
                    style={({ pressed }) => [styles.historyRow, pressed && styles.pressed]}
                  >
                    <Text style={styles.historyExpression}>
                      {prettyCalculation(record.expression)}
                    </Text>
                    <Text style={styles.historyResult}>= {record.result}</Text>
                  </Pressable>
                ))}
              </>
            )}
          </View>
        ) : (
          <>
            <View style={styles.row}>
              {["AC", "M+", "M−", "delete"].map((value) => key(value))}
            </View>
            <View style={styles.row}>{["%", "/", "*", "-"].map((value) => key(value))}</View>
            <View style={styles.row}>{["7", "8", "9", "+"].map((value) => key(value))}</View>
            <View style={styles.row}>{["4", "5", "6", "="].map((value) => key(value))}</View>
            <View style={styles.row}>
              <View style={styles.bottomNumbers}>
                <View style={styles.row}>{["1", "2", "3"].map((value) => key(value))}</View>
                <View style={styles.row}>
                  <View style={styles.doubleKeySlot}>{key("0")}</View>
                  <View style={styles.keySlot}>{key(".")}</View>
                </View>
              </View>
              <View style={styles.keySlot}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("calculator.nextNote")}
                  disabled={props.disabled}
                  onPress={() => {
                    if (canEdit()) props.onNext();
                  }}
                  style={({ pressed }) => [
                    styles.key,
                    styles.nextKey,
                    { minHeight: keyHeight * 2 + KEY_GAP },
                    pressed && styles.pressed,
                  ]}
                >
                  <Ionicons name="arrow-forward" size={27} color={colors.textEmphasis} />
                </Pressable>
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  keyboard: {
    backgroundColor: colors.bgMuted,
    borderTopWidth: 1,
    borderColor: colors.borderSubtle,
    direction: "ltr",
  },
  contentWidth: { width: "100%", maxWidth: 640, alignSelf: "center" },
  tools: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    flexDirection: "row",
    direction: "ltr",
    paddingHorizontal: 8,
  },
  tool: {
    flex: 1,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  toolText: {
    fontFamily: fonts.monoMedium,
    fontSize: 13,
    lineHeight: monoLineHeight(13, 20),
    color: colors.textSubtle,
    writingDirection: "ltr",
  },
  memorySet: { color: colors.textEmphasis },
  keys: { paddingHorizontal: 8, paddingBottom: 8, gap: KEY_GAP },
  row: { flexDirection: "row", direction: "ltr", gap: KEY_GAP },
  // Spanning groups include their internal gutters before sharing the remaining
  // width. Borderless slots keep key borders out of that flex calculation.
  bottomNumbers: { flex: 3, flexBasis: KEY_GAP * 2, gap: KEY_GAP },
  keySlot: { flex: 1 },
  doubleKeySlot: { flex: 2, flexBasis: KEY_GAP },
  key: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgDefault,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  keyText: {
    fontFamily: fonts.monoMedium,
    fontSize: 22,
    lineHeight: monoLineHeight(22, 29),
    color: colors.textEmphasis,
    writingDirection: "ltr",
  },
  smallKeyText: { fontSize: 16, lineHeight: monoLineHeight(16, 24) },
  utilityKey: { backgroundColor: colors.bgSubtle, borderColor: colors.bgSubtle },
  operatorKey: { backgroundColor: colors.bgSubtle, borderColor: colors.bgSubtle },
  equalsKey: { backgroundColor: colors.bgInverted, borderColor: colors.bgInverted },
  equalsText: { color: colors.textInverted },
  nextKey: { backgroundColor: "#E9EFEC", borderColor: "#E0E8E3" },
  pressed: { opacity: 0.55 },
  feedback: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.textSubtle,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  history: { padding: 8 },
  historyTitle: {
    fontFamily: fonts.sansSemi,
    fontSize: 14,
    lineHeight: sansLineHeight(14, 22),
    color: colors.textEmphasis,
    marginBottom: 8,
  },
  clearHistory: { minHeight: TOUCH_MIN, justifyContent: "center" },
  historyRow: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderColor: colors.borderDefault,
    minHeight: TOUCH_MIN,
  },
  historyExpression: {
    fontFamily: fonts.monoRegular,
    fontSize: 14,
    lineHeight: monoLineHeight(14, 22),
    color: colors.textSubtle,
    writingDirection: "ltr",
    textAlign: "left",
  },
  historyResult: {
    fontFamily: fonts.monoSemi,
    fontSize: 18,
    lineHeight: monoLineHeight(18, 26),
    color: colors.textEmphasis,
    writingDirection: "ltr",
    textAlign: "right",
    marginTop: 4,
  },
});
