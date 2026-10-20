import assert from "node:assert/strict";
import { evaluateCalculation, MAX_CALCULATION_LENGTH } from "../calculator";
import {
  calculatorDraft,
  calculatorKey,
  calculateDraft,
  recallCalculationValue,
  rememberCalculation,
  selectCalculation,
  type CalculatorDraft,
  type CalculatorRecord,
} from "../calculator-input";

let checks = 0;
const failures: string[] = [];
function check(label: string, run: () => void) {
  try {
    run();
    checks++;
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function keys(sequence: string[], initial = ""): CalculatorDraft {
  return sequence.reduce(calculatorKey, calculatorDraft(initial));
}
function value(draft: CalculatorDraft, expected: string) {
  const result = evaluateCalculation(draft.expression);
  assert.ok(result.status === "valid", `${draft.expression}: ${JSON.stringify(result)}`);
  assert.equal(result.value, expected, draft.expression);
  assert.ok(draft.selection.start >= 0 && draft.selection.end <= draft.expression.length);
  assert.ok(draft.selection.start <= draft.selection.end);
  return result;
}

check("rapid synchronous keys preserve every operand and precedence", () => {
  const draft = keys(["1", "0", "+", "2", "*", "3"]);
  assert.equal(draft.expression, "10+2*3");
  value(draft, "16");
  assert.equal(draft.evaluated, false);
});
for (const [sequence, expected] of [
  [["2", "0", "0", "+", "1", "0", "%"], "220"],
  [["2", "0", "0", "-", "1", "0", "%"], "180"],
  [["2", "0", "0", "*", "1", "0", "%"], "20"],
  [["2", "0", "0", "/", "1", "0", "%"], "2000"],
  [["()", "2", "+", "3", "()", "*", "4"], "20"],
  [["2", "()", "3", "+", "4", "()"], "14"],
] as [string[], string][])
  check(`key arithmetic ${sequence.join(" ")}`, () => value(keys(sequence), expected));

for (const [sequence, expected] of [
  [["1", "0", "+", "*", "2"], "20"],
  [["1", "0", "+", "-", "2"], "8"],
  [["1", "0", "-", "-", "2"], "8"],
  [["1", "0", "*", "-", "2"], "-20"],
  [["1", "0", "/", "-", "2"], "-5"],
  [["1", "0", "*", "-", "/", "2"], "5"],
] as [string[], string][])
  check(`operator replacement ${sequence.join(" ")}`, () => value(keys(sequence), expected));
check("operator replacement treats pasted whitespace like keypad input", () => {
  value(calculatorKey(calculatorKey(calculatorDraft("10 * -"), "/"), "2"), "5");
});

check("decimal starts a fractional amount and cannot repeat", () => {
  value(keys([".", "2", ".", "5"]), "0.25");
  assert.equal(keys([".", "2", ".", "5"]).expression, "0.25");
});
check("leading zero and double-zero keys do not change the intended amount", () => {
  value(keys(["0", "5", "00"]), "500");
  value(keys(["00", ".", "5"]), "0.50");
});
check("decimal cannot create a second decimal after the caret", () => {
  const draft = selectCalculation(calculatorDraft("12.34"), 1, 1);
  value(calculatorKey(draft, "."), "12.34");
});
check("decimal can replace a selected decimal point", () => {
  const draft = selectCalculation(calculatorDraft("12.34"), 2, 3);
  value(calculatorKey(draft, "."), "12.34");
});
check("fractional operand after percentage inserts multiplication", () => {
  const draft = keys(["2", "0", "0", "%", ".", "5"]);
  value(draft, "1");
});
check("digit after a closed parenthesis or percent starts multiplication", () => {
  value(keys(["2", "()", "3", "()", "4"]), "24");
  value(keys(["5", "0", "%", "2"]), "1");
});

check("delete removes one character at the caret", () => {
  value(calculatorKey(selectCalculation(calculatorDraft("123+456"), 2, 2), "delete"), "469");
});
check("delete selection preserves the rest and exposes incomplete input", () => {
  const draft = calculatorKey(selectCalculation(calculatorDraft("123+456"), 4, 7), "delete");
  assert.equal(draft.expression, "123+");
  assert.equal(evaluateCalculation(draft.expression).status, "incomplete");
  value(calculatorKey(draft, "7"), "130");
});
check("delete at the start is a no-op", () => {
  const draft = selectCalculation(calculatorDraft("123"), 0, 0);
  assert.equal(calculatorKey(draft, "delete"), draft);
});
check("AC clears expression, selection, evaluated state and repeated operation", () => {
  const draft = calculatorKey(keys(["1", "0", "+", "2", "=", "="]), "AC");
  assert.deepEqual(draft, calculatorDraft());
});
check("selection clamps native indices to the actual expression", () => {
  assert.deepEqual(selectCalculation(calculatorDraft("123"), -10, 100).selection, {
    start: 0,
    end: 3,
  });
  assert.deepEqual(selectCalculation(calculatorDraft("123"), 100, -10).selection, {
    start: 3,
    end: 3,
  });
});

check("sign toggles a number on and off", () => {
  let draft = keys(["1", "2", "sign"]);
  value(draft, "-12");
  draft = calculatorKey(draft, "sign");
  value(draft, "12");
});
check("sign toggles an operand without changing its binary minus", () => {
  let draft = calculatorKey(calculatorDraft("10-2"), "sign");
  value(draft, "12");
  draft = calculatorKey(draft, "sign");
  value(draft, "8");
});
check("sign after a trailing decimal toggles the operand", () => {
  value(calculatorKey(calculatorDraft("12."), "sign"), "-12");
});
check("sign at a decimal caret toggles the complete current number", () => {
  let draft = calculatorKey(selectCalculation(calculatorDraft("10+12.34"), 6, 6), "sign");
  value(draft, "-2.34");
  draft = calculatorKey(draft, "sign");
  value(draft, "22.34");
});
check("sign toggles the last parenthesized operand, not the entire expression", () => {
  let draft = calculatorKey(calculatorDraft("10+(2+3)"), "sign");
  value(draft, "5");
  draft = calculatorKey(draft, "sign");
  value(draft, "15");
});
check("sign toggles a complete nested group", () => {
  let draft = calculatorKey(calculatorDraft("10+((2+3)*4)"), "sign");
  value(draft, "-10");
  draft = calculatorKey(draft, "sign");
  value(draft, "30");
});
check("sign toggles a selected expression and its resulting group", () => {
  let draft = calculatorKey(selectCalculation(calculatorDraft("10+2*3"), 3, 6), "sign");
  value(draft, "4");
  draft = calculatorKey(draft, "sign");
  value(draft, "16");
});
check("sign negates an entire selection of separate parenthesized terms", () => {
  const draft = calculatorDraft("(2)+(3)");
  value(calculatorKey(selectCalculation(draft, 0, draft.expression.length), "sign"), "-5");
});
check("sign negates an entire selected compound that starts negative", () => {
  let draft = calculatorKey(selectCalculation(calculatorDraft("-2+3"), 0, 4), "sign");
  value(draft, "-1");
  draft = calculatorKey(draft, "sign");
  value(draft, "1");
});
check("sign negates a selected negative product without changing its outside context", () => {
  const expression = "10+(-2*3)";
  const draft = calculatorKey(selectCalculation(calculatorDraft(expression), 4, 8), "sign");
  value(draft, "16");
});
check("sign applies to a percentage operand", () => {
  let draft = calculatorKey(calculatorDraft("200+10%"), "sign");
  value(draft, "180");
  draft = calculatorKey(draft, "sign");
  value(draft, "220");
});

for (const [expression, expected] of [
  ["10+2", ["12", "14", "16"]],
  ["200+10%", ["220", "242", "266.20"]],
  ["10+2*3", ["16", "22", "28"]],
  ["10-(2+3)", ["5", "0", "-5"]],
  ["100/2/5", ["10", "2", "0.40"]],
  ["2*-3", ["-6", "18", "-54"]],
  ["10 + 2", ["12", "14", "16"]],
  ["10.+2", ["12", "14", "16"]],
] as [string, string[]][])
  check(`repeated equals ${expression}`, () => {
    let draft = calculatorDraft(expression);
    for (const result of expected) {
      draft = calculateDraft(draft);
      value(draft, result);
      assert.equal(draft.evaluated, true);
    }
  });
check("operator after equals continues the result and replaces repeated operation", () => {
  let draft = keys(["1", "0", "+", "2", "=", "*", "3", "="]);
  value(draft, "36");
  draft = calculatorKey(draft, "=");
  value(draft, "108");
});
check("digit or decimal after equals starts a new calculation", () => {
  const evaluated = keys(["1", "0", "+", "2", "="]);
  value(calculatorKey(evaluated, "7"), "7");
  value(calculatorKey(calculatorKey(evaluated, "."), "5"), "0.50");
});
check("sign and delete after equals edit the answer, with no stale repeat", () => {
  const evaluated = keys(["1", "0", "+", "2", "="]);
  const signed = calculatorKey(evaluated, "sign");
  value(signed, "-12");
  assert.equal(signed.repeat, null);
  value(calculatorKey(evaluated, "delete"), "1");
});
for (const expression of ["", "1+", "1/0", "1+bad"])
  check(`equals cannot invent an answer for ${JSON.stringify(expression)}`, () => {
    const draft = calculatorDraft(expression);
    assert.equal(calculateDraft(draft), draft);
    assert.equal(evaluateCalculation(draft.expression).canApply, false);
  });

for (const [expression, memory, expected] of [
  ["", "5", "5"],
  ["", "0", "0"],
  ["10+", "5", "15"],
  ["10*", "-5", "-50"],
  ["10+2", "5", "15"],
  ["-2", "3", "3"],
  ["10*-2", "5", "50"],
  ["10*-2", "-5", "-50"],
  ["10*-", "5", "-50"],
  ["10*-", "-5", "50"],
  ["200+10%", "5", "205"],
] as [string, string, string][])
  check(`MR ${memory} into ${JSON.stringify(expression)}`, () => {
    value(recallCalculationValue(calculatorDraft(expression), memory), expected);
  });
check("MR replaces a selection and a completed result", () => {
  const selected = selectCalculation(calculatorDraft("10+2*3"), 3, 6);
  value(recallCalculationValue(selected, "-4"), "6");
  const evaluated = keys(["1", "0", "+", "2", "="]);
  const recalled = recallCalculationValue(evaluated, "-4");
  value(recalled, "-4");
  assert.equal(recalled.repeat, null);
  assert.equal(recalled.evaluated, false);
});
check("MR replaces the full numeric operand around the caret", () => {
  const draft = selectCalculation(calculatorDraft("10+1234"), 5, 5);
  value(recallCalculationValue(draft, "5"), "15");
});
check("MR replaces a closed group as one operand", () => {
  value(recallCalculationValue(calculatorDraft("10+(2+3)"), "4"), "14");
});
check("MR at a group/percent caret replaces the whole percentage operand", () => {
  const expression = "200+(10+5)%";
  const draft = selectCalculation(
    calculatorDraft(expression),
    expression.indexOf("%"),
    expression.indexOf("%"),
  );
  value(recallCalculationValue(draft, "5"), "205");
});

check("history deduplicates consecutive identical records without mutation", () => {
  const first = { expression: "10+2", result: "12" };
  const initial: CalculatorRecord[] = [];
  const history = rememberCalculation(initial, first);
  assert.equal(initial.length, 0);
  assert.deepEqual(history, [first]);
  assert.equal(rememberCalculation(history, { ...first }), history);
  assert.deepEqual(rememberCalculation(history, { ...first, result: "14" }), [
    { ...first, result: "14" },
    first,
  ]);
});
check("history keeps only the latest 20 records in order", () => {
  let history: CalculatorRecord[] = [];
  for (let index = 0; index < 25; index++)
    history = rememberCalculation(history, { expression: `${index}+1`, result: String(index + 1) });
  assert.equal(history.length, 20);
  assert.equal(history[0].expression, "24+1");
  assert.equal(history[19].expression, "5+1");
});
check("localized valid input normalizes without changing its value", () => {
  const draft = calculatorDraft("۱۲٫۵ + ۵");
  assert.equal(draft.expression, "12.5 + 5");
  value(draft, "17.50");
});
for (const expression of ["12abc34", "1,234", "0x10", "1;2"])
  check(`unsupported input is retained and rejected: ${expression}`, () => {
    const draft = calculatorDraft(expression);
    assert.equal(draft.expression, expression);
    const result = evaluateCalculation(draft.expression);
    assert.equal(result.status, "error");
    assert.equal(result.amount, null);
    assert.equal(calculateDraft(draft), draft);
  });
check("oversized financial input is never silently truncated", () => {
  const expression = "9".repeat(MAX_CALCULATION_LENGTH);
  const draft = calculatorKey(calculatorDraft(expression), "1");
  assert.equal(draft.expression, expression + "1");
  const result = evaluateCalculation(draft.expression);
  assert.ok(result.status === "error");
  assert.equal(result.code, "too_complex");
  assert.equal(result.amount, null);
});

if (failures.length)
  throw new Error(`calculator-input selftest: ${failures.length} failures\n${failures.join("\n")}`);
console.log(`calculator-input selftest: ${checks} checks passed`);
