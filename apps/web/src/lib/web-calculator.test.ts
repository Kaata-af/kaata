import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateDraft,
  calculationOperand,
  calculatorDraft,
  calculatorKey,
  evaluateCalculation,
  MAX_CALCULATION_LENGTH,
  normalizeCalculationInput,
  selectCalculation,
} from "./mobile-domain";
import { evaluateCalculation as mobileEvaluateCalculation } from "../../../mobile/lib/calculator";

function applied(expression: string, amount: string, minor: number) {
  const result = evaluateCalculation(expression);
  assert.equal(result.status, "valid", expression);
  assert.ok(result.canApply, expression);
  assert.equal(result.amount, amount, expression);
  assert.equal(result.amountMinor, minor, expression);
  return result;
}

test("web calculation uses the mobile engine and preserves exact decimal cents", () => {
  assert.equal(evaluateCalculation, mobileEvaluateCalculation);
  for (const [expression, amount, minor] of [
    ["0.1+0.2", "0.30", 30],
    ["0.29+0.01", "0.30", 30],
    ["1/3*3", "1", 100],
    ["0.335*3", "1.01", 101],
    ["(2+3)*4", "20", 2000],
    ["2(3+4)", "14", 1400],
    ["123.456-123.451", "0.01", 1],
  ] as const)
    applied(expression, amount, minor);
});

test("business percentages match the running amount and ordinary products", () => {
  for (const [expression, amount, minor] of [
    ["200+10%", "220", 22000],
    ["200-10%", "180", 18000],
    ["200+10%+10%", "242", 24200],
    ["200*10%", "20", 2000],
    ["200/10%", "2000", 200000],
    ["200+10%*2", "200.20", 20020],
    ["200+(5+5)%", "220", 22000],
  ] as const)
    applied(expression, amount, minor);
});

test("rounding occurs once and continuing after equals retains the exact answer", () => {
  const rounded = applied("1.005", "1.01", 101);
  assert.equal(rounded.rounded, true);
  assert.equal(applied("1/8", "0.13", 13).rounded, true);
  let draft = calculateDraft(calculatorDraft("1/3"));
  const third = evaluateCalculation(draft.expression);
  assert.equal(third.status, "valid");
  if (third.status !== "valid") return;
  assert.equal(calculationOperand(third), "(1/3)");
  draft = calculatorKey(calculatorKey(draft, "*"), "3");
  applied(draft.expression, "1", 100);
  draft = calculateDraft(calculatorDraft("100+10%"));
  applied(calculateDraft(draft).expression, "121", 12100);
});

test("Dari and Arabic digits, decimal marks and math glyphs keep their meaning", () => {
  assert.equal(normalizeCalculationInput(" ۱۲٫۳ × ۴٪ − ۲ ÷ ۵ "), "12.3 * 4% - 2 / 5");
  applied("١٢٫٥×۲", "25", 2500);
  applied("۲۰۰−۱۰٪", "180", 18000);
  applied("۱٬۲۳۴٫۵۰+۵٫۵۰", "1240", 124000);
  applied("1,25+2,50", "3.75", 375);
  applied("\u2067۱۲٫۵\u2069 + \u200f۰٫۵", "13", 1300);
  const ambiguous = evaluateCalculation("1,234");
  assert.equal(ambiguous.status, "error");
  assert.equal(ambiguous.canApply, false);
  assert.equal(ambiguous.amount, null);
});

test("incomplete, invalid and zero-divisor calculations never expose an applicable amount", () => {
  for (const expression of ["", "300+", "(2+3", "1/0", "1/(2-2)", "2**3", "1+alert(1)"]) {
    const result = evaluateCalculation(expression);
    assert.notEqual(result.status, "valid", expression);
    assert.equal(result.canApply, false, expression);
    assert.equal(result.amount, null, expression);
    assert.equal(result.amountMinor, null, expression);
  }
  const divide = evaluateCalculation("1/0");
  assert.equal(divide.status, "error");
  if (divide.status === "error") assert.equal(divide.code, "division_by_zero");
});

test("only positive cent results within the mobile entry limit can be applied", () => {
  applied("9999999999.99", "9999999999.99", 999999999999);
  applied("0.005", "0.01", 1);
  for (const expression of ["0", "-1", "-0.005", "0.004", "9999999999.99+0.01", "9999999999.995"]) {
    const result = evaluateCalculation(expression);
    assert.equal(result.status, "valid", expression);
    assert.equal(result.canApply, false, expression);
    assert.equal(result.amount, null, expression);
  }
});

test("the shared controller corrects selections and rejects stale partial results", () => {
  const edited = calculatorKey(selectCalculation(calculatorDraft("12+3"), 0, 2), "5");
  applied(edited.expression, "8", 800);
  const partial = calculatorKey(calculatorDraft("300"), "+");
  assert.equal(evaluateCalculation(partial.expression).status, "incomplete");
  assert.equal(evaluateCalculation(partial.expression).amount, null);
  const cleared = calculatorKey(calculateDraft(calculatorDraft("1/3")), "AC");
  assert.deepEqual(cleared, calculatorDraft());
});

test("expression length and nesting limits fail closed at the mobile bounds", () => {
  applied("0".repeat(MAX_CALCULATION_LENGTH - 1) + "1", "1", 100);
  for (const expression of [
    "0".repeat(MAX_CALCULATION_LENGTH) + "1",
    "(".repeat(33) + "1" + ")".repeat(33),
  ]) {
    const result = evaluateCalculation(expression);
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.code, "too_complex");
    assert.equal(result.canApply, false);
    assert.equal(result.amount, null);
  }
});
