import assert from "node:assert/strict";
import {
  evaluateCalculation,
  calculationOperand,
  MAX_CALCULATION_LENGTH,
  normalizeCalculationInput,
  type CalculationErrorCode,
} from "../calculator";
import { MAX_ENTRY_AMOUNT, parseAmountInput, toMinorUnits } from "../money";

let checks = 0;
function valid(expression: string, expected: string, canApply = true) {
  const result = evaluateCalculation(expression);
  assert.ok(result.status === "valid", `${expression}: ${JSON.stringify(result)}`);
  assert.equal(result.display, expected, expression);
  assert.equal(result.value, expected, expression);
  assert.equal(result.canApply, canApply, expression);
  if (result.canApply) {
    assert.equal(result.amount, expected);
    const parsed = parseAmountInput(result.amount);
    assert.notEqual(parsed, null, "every applicable amount passes the real money parser");
    assert.equal(toMinorUnits(parsed!), result.amountMinor);
    assert.ok(Number.isSafeInteger(result.amountMinor));
    assert.ok(parsed! <= MAX_ENTRY_AMOUNT);
  } else {
    assert.equal(
      result.amount,
      null,
      "displaying a mathematical answer cannot accidentally apply it",
    );
    assert.equal(result.amountMinor, null);
  }
  checks++;
  return result;
}
function unavailable(
  expression: string,
  status: "incomplete" | "error",
  code?: CalculationErrorCode,
) {
  const result = evaluateCalculation(expression);
  assert.equal(result.status, status, expression);
  assert.equal(result.canApply, false, expression);
  assert.equal(result.display, null, "unfinished/invalid input has no misleading partial answer");
  assert.equal(result.value, null);
  assert.equal(result.amount, null);
  assert.equal(result.amountMinor, null);
  assert.equal(result.exactValue, null);
  if (code) {
    assert.ok(result.status === "error");
    assert.equal(result.code, code, expression);
  }
  checks++;
}

for (const [expression, expected] of [
  ["0.1+0.2", "0.30"],
  ["0.29+0.01", "0.30"],
  ["1-0.9-0.1", "0"],
  ["0.1/0.3*3", "1"],
  ["1/3*3", "1"],
  ["1/7*7", "1"],
  ["10/6*3", "5"],
  ["1.005", "1.01"],
  ["2.675", "2.68"],
  ["0.335*3", "1.01"],
  ["1/8", "0.13"],
  ["1/6", "0.17"],
  ["2/3", "0.67"],
  ["5/2", "2.50"],
  ["1/200", "0.01"],
  ["1/2000", "0"],
  ["0.004999999999999999999999", "0"],
  ["0.005000000000000000000001", "0.01"],
  [".5+.25", "0.75"],
  ["12.", "12"],
  ["1,", "1"],
  ["00012.5000", "12.50"],
  [".01*.1", "0"],
  [".001*1000", "1"],
  ["123.456-123.451", "0.01"],
  ["123.451-123.456", "-0.01"],
] as const)
  valid(expression, expected, expected !== "0" && !expected.startsWith("-"));

for (const [expression, expected] of [
  ["200+10%", "220"],
  ["200-10%", "180"],
  ["200*10%", "20"],
  ["200/10%", "2000"],
  ["200+(10%)", "220"],
  ["200+(5+5)%", "220"],
  ["200-(5+5)%", "180"],
  ["200+(-10%)", "180"],
  ["200--10%", "220"],
  ["200+10%+10%", "242"],
  ["(200+20%)-10%", "216"],
  ["(200+10%)*2", "440"],
  ["200+10%*2", "200.20"],
  ["50%", "0.50"],
  ["100*5%%", "0.05"],
  ["2+3*4", "14"],
  ["(2+3)*4", "20"],
  ["20/5/2", "2"],
  ["20-5-2", "13"],
  ["2--3", "5"],
  ["-(-2)", "2"],
  ["(-1.5)*(-2)", "3"],
  ["2(3+4)", "14"],
  ["(2)(3)", "6"],
  ["(2)3", "6"],
  [" 2 + 3 \n * 4 ", "14"],
  ["3*4+5*6", "42"],
  ["24/6*2", "8"],
  ["24/(6*2)", "2"],
  ["24/(6/2)", "8"],
  ["10-(3-2)", "9"],
  ["-(2+3)*-4", "20"],
  ["- - 3 + + 2", "5"],
  ["2/-(-4)", "0.50"],
  ["(.5)(.4)", "0.20"],
  ["2(3+4)(5-2)", "42"],
  ["(2+3)4", "20"],
  ["1000+12.5%", "1125"],
  ["1000-12.5%", "875"],
  ["80/25%", "320"],
  ["80*25%", "20"],
  ["100+5%+5%", "110.25"],
  ["100-5%-5%", "90.25"],
  ["100+(50/2)%", "125"],
  ["100+((10%))", "110"],
  ["100*25%*4", "100"],
  ["100/(25%)", "400"],
  ["2(25%)", "0.50"],
  ["200+(10%*2)", "200.20"],
] as const)
  valid(expression, expected);

for (const [expression, expected] of [
  ["-1.005", "-1.01"],
  ["-0.005", "-0.01"],
  ["-0.004", "0"],
  ["2*-3", "-6"],
  ["2(-3)", "-6"],
  ["2+-3", "-1"],
  ["2---3", "-1"],
  ["-200+10%", "-220"],
  ["0", "0"],
  ["-0", "0"],
  ["-0.0000000000000000001", "0"],
  ["0/-2", "0"],
  ["10/-4", "-2.50"],
  ["-(2+3)%", "-0.05"],
] as const) {
  const result = valid(expression, expected, false);
  assert.equal(result.applyError, "non_positive");
}

for (const [expression, expected] of [
  ["١٢٫٥×۲", "25"],
  ["۲۰۰−۱۰٪", "180"],
  ["۲۰۰÷۱۰٪", "2000"],
  ["۱٬۲۳۴٫۵۰+۵٫۵۰", "1240"],
  ["۱٬۰۰۰,۵۰+۱", "1001.50"],
  ["1,25+2,50", "3.75"],
  ["\u2067۱۲٫۵\u2069 + \u200f۰٫۵", "13"],
  ["−١٬٢٣٤٫٥٠ + ۲٬۰۰۰٫۵۰", "766"],
  ["۰٫۱＋۰٫۲", "0.30"],
  ["(۲۵٪)×۴", "1"],
  ["0,1+0,2", "0.30"],
] as const)
  valid(expression, expected);
assert.equal(normalizeCalculationInput(" ۱۲٫۳ × ۴٪ − ۲ ÷ ۵ "), "12.3 * 4% - 2 / 5");
checks++;

for (const expression of [
  "",
  " ",
  "-",
  "+",
  ".",
  "1+",
  "1-",
  "1*",
  "1/",
  "1--",
  "1+.",
  "(",
  "((",
  "1+(",
  "(1+2",
  "1/(0",
  "300+",
  "300-",
  "300×",
  "300÷",
  "300+-",
  "2(3",
  "(2)(",
  "2+,",
])
  unavailable(expression, "incomplete");
for (const expression of [
  "()",
  ")",
  "1)",
  "1+)",
  "1..2",
  "1.2.3",
  "1 2",
  "1,234",
  "1,000.50",
  "1٬23",
  "1234٬567",
  "2**3",
  "1%2",
  "NaN",
  "Infinity",
  "1e3",
  "0x10",
  "2x3",
  "2X3",
  "Math.pow(2,3)",
  "globalThis.calculatorExecuted=1",
  "2;3",
  "2=2",
  "1+alert(1)",
  "*2",
  "/2",
  "%",
  "((1)))",
  "1+(2))",
  "1 + * 2",
  "1 / / 2",
  "1,,2",
  "1٫2٫3",
  "1٬234٬56",
  "1.2٬345",
  "1,234,567",
  "1,234.50+2",
  "1\u00002",
  "2²",
  "√4",
])
  unavailable(expression, "error", "invalid_expression");
for (const expression of [
  "1/0",
  "0/0",
  "1/(2-2)",
  "1/0%",
  "1/(0%)",
  "1/0+",
  "1/-0",
  "1/(.1+.2-.3)",
  "1/(100-100%)",
  "0*(1/0)",
])
  unavailable(expression, "error", "division_by_zero");

const repeating = valid("1/3", "0.33");
assert.deepEqual(repeating.exactValue, { numerator: "1", denominator: "3" });
assert.equal(repeating.rounded, true);
const terminating = valid("0.1+0.2", "0.30");
assert.deepEqual(terminating.exactValue, { numerator: "3", denominator: "10" });
assert.equal(terminating.rounded, false);
assert.equal(valid("1.005", "1.01").rounded, true);
assert.equal(valid("1.230000", "1.23").rounded, false);

// Equals and memory can show rounded cents without replacing the exact
// intermediate used by the next operation. A saved tally still uses amount.
for (const [source, operation, expected] of [
  ["1/3", "*3", "1"],
  ["-1/3", "*-3", "1"],
  ["1/6", "*6", "1"],
  ["1.005", "*1000", "1005"],
  [".004", "*1000", "4"],
  ["-.004", "*-1000", "4"],
  [".0005", "*2000", "1"],
  ["-.0005", "*-2000", "1"],
] as const) {
  const initial = evaluateCalculation(source);
  assert.ok(initial.status === "valid");
  const operand = calculationOperand(initial);
  const replay = evaluateCalculation(operand);
  assert.ok(replay.status === "valid");
  assert.deepEqual(replay.exactValue, initial.exactValue, source);
  valid(`${operand}${operation}`, expected);
}
const thirdOperand = calculationOperand(repeating);
assert.equal(thirdOperand, "(1/3)");
valid(`${thirdOperand}+${calculationOperand(valid("2/3", "0.67"))}`, "1");
const subCent = valid(".004", "0", false);
assert.equal(calculationOperand(subCent), "0.004");
valid(`(${calculationOperand(subCent)}+${calculationOperand(subCent)})*1000`, "8");
assert.equal(calculationOperand(valid("-.004", "0", false)), "-0.004");
assert.equal(calculationOperand(valid("1.005", "1.01")), "1.005");
assert.equal(calculationOperand(valid("50%", "0.50")), "0.50");
valid(`100+${calculationOperand(valid("50%", "0.50"))}`, "100.50");
const longDecimal = `0.${"1".repeat(130)}`;
const longExact = valid(longDecimal, "0.11");
assert.equal(calculationOperand(longExact), longDecimal);
const longContinued = evaluateCalculation(`${calculationOperand(longExact)}*2`);
assert.ok(longContinued.status === "valid");
assert.equal(longContinued.value, "0.22");
let carried = repeating;
for (let index = 0; index < 25; index++) {
  const one = valid(`${calculationOperand(carried)}*3`, "1");
  carried = valid(`${calculationOperand(one)}/3`, "0.33");
  assert.deepEqual(carried.exactValue, { numerator: "1", denominator: "3" });
  assert.ok(calculationOperand(carried).length <= MAX_CALCULATION_LENGTH);
}

const maximum = valid("9999999999.99", "9999999999.99");
assert.equal(maximum.amountMinor, 999_999_999_999);
valid("10000000000-.01", "9999999999.99");
valid("9999999999.99+.004", "9999999999.99");
valid("9999999999.994999999", "9999999999.99");
valid("-9999999999.99+10000000000", "0.01");
for (const expression of ["10000000000", "9999999999.99+.005", "9999999999.99*2"])
  assert.equal(
    valid(expression, expression === "9999999999.99*2" ? "19999999999.98" : "10000000000", false)
      .applyError,
    "amount_too_large",
  );

// Exact large intermediates may cancel to an ordinary amount. Casting each
// operand to Number, or rejecting the monetary range before the end, fails.
const huge = "9".repeat(100);
valid(`(${huge}+1)-${huge}`, "1");
valid(`${huge}-${huge}`, "0", false);
const bigProduct = valid(`${huge}*${huge}`, String(BigInt(huge) * BigInt(huge)), false);
assert.equal(bigProduct.applyError, "amount_too_large");
valid("(".repeat(32) + "1" + ")".repeat(32), "1");
unavailable("(".repeat(33) + "1" + ")".repeat(33), "error", "too_complex");
unavailable("1".repeat(MAX_CALCULATION_LENGTH + 1), "error", "too_complex");
assert.equal(
  valid("1".repeat(MAX_CALCULATION_LENGTH), "1".repeat(MAX_CALCULATION_LENGTH), false).applyError,
  "amount_too_large",
);

// Deterministic money identities use independent integer-cent expectations.
// The division identity also catches any rounding of intermediate previews.
const decimal = (minor: number) =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
for (let index = 1; index <= 100; index++) {
  const a = ((index * 7919) % 100_000) + 1;
  const b = ((index * 31337) % 100_000) + 1;
  const sum = evaluateCalculation(`${decimal(a)}+${decimal(b)}`);
  assert.ok(sum.status === "valid" && sum.canApply);
  assert.equal(sum.amountMinor, a + b);
  const difference = evaluateCalculation(`(${decimal(a)}+${decimal(b)})-${decimal(a)}`);
  assert.ok(difference.status === "valid" && difference.canApply);
  assert.equal(difference.amountMinor, b);
  const identity = evaluateCalculation(`${decimal(a)}/${decimal(b)}*${decimal(b)}`);
  assert.ok(identity.status === "valid" && identity.canApply);
  assert.equal(identity.amountMinor, a);
  checks += 3;
}

console.log(`calculator selftest: ${checks} checks passed`);
