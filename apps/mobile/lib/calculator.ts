import { toAsciiDigits } from "./digits";
import { MAX_ENTRY_AMOUNT, parseAmountInput, toMinorUnits } from "./money";

export const MAX_CALCULATION_LENGTH = 256;
const MAX_GROUP_DEPTH = 32;
const MAX_INTEGER_DIGITS = 512;
const MAX_AMOUNT_MINOR = BigInt(toMinorUnits(MAX_ENTRY_AMOUNT));

export type CalculationErrorCode =
  | "invalid_expression"
  | "division_by_zero"
  | "too_complex"
  | "overflow";
export type CalculationApplyError = "non_positive" | "amount_too_large";
type ExactValue = { numerator: string; denominator: string };
type ValidCalculation = {
  status: "valid";
  normalizedExpression: string;
  /** Signed ASCII monetary result, rounded once to cents; never grouped. */
  display: string;
  value: string;
  /** Reduced exact rational, including results with no finite decimal form. */
  exactValue: ExactValue;
  rounded: boolean;
} & (
  | { canApply: true; amount: string; amountMinor: number; applyError: null }
  | {
      canApply: false;
      amount: null;
      amountMinor: null;
      applyError: CalculationApplyError;
    }
);
type UnavailableCalculation = {
  normalizedExpression: string;
  canApply: false;
  display: null;
  value: null;
  exactValue: null;
  amount: null;
  amountMinor: null;
};
export type CalculationResult =
  | ValidCalculation
  | (UnavailableCalculation & { status: "incomplete" })
  | (UnavailableCalculation & { status: "error"; code: CalculationErrorCode });

/** Continue arithmetic with the exact result, even when its monetary preview
 * rounded to cents (including a signed sub-cent value displayed as zero).
 * The compact operand uses the same bounded parser syntax as typed input;
 * callers still evaluate the complete next expression before accepting it.
 */
export function calculationOperand(result: ValidCalculation): string {
  if (!result.rounded) return result.value;
  const ratio = `(${result.exactValue.numerator}/${result.exactValue.denominator})`;
  const numerator = BigInt(result.exactValue.numerator);
  const denominator = BigInt(result.exactValue.denominator);
  const magnitude = numerator < 0n ? -numerator : numerator;
  let decimal = `${numerator < 0n ? "-" : ""}${magnitude / denominator}.`;
  let remainder = magnitude % denominator;
  // Prefer a short finite decimal (1.005 instead of 201/200). Bounded long
  // division also handles repeating fractions without ever growing an operand
  // beyond the shorter supported representation or the expression budget.
  const limit = Math.min(ratio.length, MAX_CALCULATION_LENGTH);
  while (remainder !== 0n && decimal.length < limit) {
    remainder *= 10n;
    decimal += String(remainder / denominator);
    remainder %= denominator;
  }
  return remainder === 0n && decimal.length < ratio.length ? decimal : ratio;
}

/** Normalize presentation, preserving malformed input for an honest error.
 * A decimal comma follows money.ts's unambiguous 0–2 fractional digit rule.
 * Arabic thousands marks are accepted only as complete three-digit groups;
 * ambiguous ASCII grouping such as 1,234 is never guessed or stripped.
 */
export function normalizeCalculationInput(expression: string): string {
  return toAsciiDigits(expression)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[−﹣－]/g, "-")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/＋/g, "+")
    .replace(/٪/g, "%")
    .replace(/٫/g, ".")
    .replace(/[0-9.,٬]+/g, (literal) => {
      const ungrouped = /^\d{1,3}(?:٬\d{3})+(?:[.,]\d*)?$/.test(literal)
        ? literal.replace(/٬/g, "")
        : literal;
      return /^\d*,\d{0,2}$/.test(ungrouped) ? ungrouped.replace(",", ".") : ungrouped;
    })
    .trim();
}

class CalculationFailure extends Error {
  constructor(readonly code: CalculationErrorCode | "incomplete") {
    super(code);
  }
}
type Rational = { numerator: bigint; denominator: bigint };
const abs = (value: bigint) => (value < 0n ? -value : value);
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new CalculationFailure("division_by_zero");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = gcd(abs(numerator), denominator);
  numerator /= divisor;
  denominator /= divisor;
  if (
    abs(numerator).toString().length > MAX_INTEGER_DIGITS ||
    denominator.toString().length > MAX_INTEGER_DIGITS
  )
    throw new CalculationFailure("overflow");
  return { numerator, denominator };
}
function add(a: Rational, b: Rational, subtract = false): Rational {
  return rational(
    a.numerator * b.denominator + (subtract ? -b.numerator : b.numerator) * a.denominator,
    a.denominator * b.denominator,
  );
}
function multiply(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}
function divide(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

type Operator = "+" | "-" | "*" | "/" | "(" | ")" | "%";
type Token = { kind: "number"; value: Rational } | { kind: Operator | "end" };
function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < expression.length) {
    const character = expression[offset];
    if (/\s/.test(character)) {
      offset++;
      continue;
    }
    if (/[0-9.,٬]/.test(character)) {
      const start = offset;
      while (offset < expression.length && /[0-9.,٬]/.test(expression[offset])) offset++;
      const literal = expression.slice(start, offset);
      if (literal === "." && !expression.slice(offset).trim())
        throw new CalculationFailure("incomplete");
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(literal))
        throw new CalculationFailure("invalid_expression");
      const [whole, fraction = ""] = literal.split(".");
      tokens.push({
        kind: "number",
        value: rational(BigInt((whole || "0") + fraction), 10n ** BigInt(fraction.length)),
      });
      continue;
    }
    if ("+-*/()%".includes(character)) {
      tokens.push({ kind: character as Operator });
      offset++;
      continue;
    }
    throw new CalculationFailure("invalid_expression");
  }
  return [...tokens, { kind: "end" }];
}

type Operand = { value: Rational; percent: boolean };
class Parser {
  private cursor = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek() {
    return this.tokens[this.cursor].kind;
  }
  parse(): Rational {
    const result = this.sum();
    if (this.peek() !== "end") throw new CalculationFailure("invalid_expression");
    return result.value;
  }
  private sum(): Operand {
    let left = this.product();
    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.tokens[this.cursor++].kind;
      const right = this.product();
      // Business percentages are relative to the running left-hand amount
      // only when the complete additive operand is a percentage: 200+10%=220.
      // A product/quotient is ordinary arithmetic: 200+10%*2 = 200.2.
      const change = right.percent ? multiply(left.value, right.value) : right.value;
      left = { value: add(left.value, change, operator === "-"), percent: false };
    }
    return left;
  }
  private product(): Operand {
    let left = this.unary();
    while (true) {
      const next = this.peek();
      // Standard juxtaposition supports 2(3+4), (2)(3), and (2)3, while
      // separate numeric literals such as "1 2" remain invalid.
      const implicit =
        next === "(" || (next === "number" && this.tokens[this.cursor - 1]?.kind === ")");
      if (next !== "*" && next !== "/" && !implicit) break;
      if (!implicit) this.cursor++;
      const right = this.unary();
      left = {
        value: next === "/" ? divide(left.value, right.value) : multiply(left.value, right.value),
        percent: false,
      };
    }
    return left;
  }
  private unary(): Operand {
    let negative = false;
    while (this.peek() === "+" || this.peek() === "-") {
      if (this.tokens[this.cursor++].kind === "-") negative = !negative;
    }
    let operand = this.primary();
    while (this.peek() === "%") {
      this.cursor++;
      operand = { value: divide(operand.value, rational(100n)), percent: true };
    }
    return negative
      ? { ...operand, value: rational(-operand.value.numerator, operand.value.denominator) }
      : operand;
  }
  private primary(): Operand {
    const token = this.tokens[this.cursor];
    if (token.kind === "end") throw new CalculationFailure("incomplete");
    if (token.kind === "number") {
      this.cursor++;
      return { value: token.value, percent: false };
    }
    if (token.kind !== "(") throw new CalculationFailure("invalid_expression");
    if (++this.depth > MAX_GROUP_DEPTH) throw new CalculationFailure("too_complex");
    this.cursor++;
    const inner = this.sum();
    if (this.peek() === "end") throw new CalculationFailure("incomplete");
    if (this.peek() !== ")") throw new CalculationFailure("invalid_expression");
    this.cursor++;
    this.depth--;
    return inner;
  }
}

function monetaryResult(value: Rational): { minor: bigint; text: string; rounded: boolean } {
  const scaled = abs(value.numerator) * 100n;
  const quotient = scaled / value.denominator;
  const remainder = scaled % value.denominator;
  const magnitude = quotient + (remainder * 2n >= value.denominator ? 1n : 0n);
  const minor = value.numerator < 0n ? -magnitude : magnitude;
  const cents = magnitude % 100n;
  const text = `${minor < 0n ? "-" : ""}${magnitude / 100n}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
  return { minor, text, rounded: minor * value.denominator !== value.numerator * 100n };
}

/** Evaluate a bounded expression without executing JavaScript or rounding
 * intermediate values. Unfinished input never exposes an old/partial amount.
 * The final monetary result rounds half away from zero once to two decimals.
 * Positive, in-range results must also round-trip through the app's money
 * parser before an applicable amount is returned.
 */
export function evaluateCalculation(expression: string): CalculationResult {
  const normalizedExpression =
    typeof expression === "string" ? normalizeCalculationInput(expression) : "";
  const unavailable: UnavailableCalculation = {
    normalizedExpression,
    canApply: false,
    display: null,
    value: null,
    exactValue: null,
    amount: null,
    amountMinor: null,
  };
  try {
    if (typeof expression !== "string") throw new CalculationFailure("invalid_expression");
    if (
      expression.length > MAX_CALCULATION_LENGTH ||
      normalizedExpression.length > MAX_CALCULATION_LENGTH
    )
      throw new CalculationFailure("too_complex");
    const value = new Parser(tokenize(normalizedExpression)).parse();
    const result = monetaryResult(value);
    const common = {
      status: "valid" as const,
      normalizedExpression,
      display: result.text,
      value: result.text,
      exactValue: { numerator: String(value.numerator), denominator: String(value.denominator) },
      rounded: result.rounded,
    };
    const applyError =
      result.minor <= 0n
        ? "non_positive"
        : result.minor > MAX_AMOUNT_MINOR
          ? "amount_too_large"
          : null;
    if (applyError)
      return { ...common, canApply: false, amount: null, amountMinor: null, applyError };
    const amountMinor = Number(result.minor);
    const parsed = parseAmountInput(result.text);
    if (
      !Number.isSafeInteger(amountMinor) ||
      parsed === null ||
      toMinorUnits(parsed) !== amountMinor
    )
      throw new CalculationFailure("overflow");
    return { ...common, canApply: true, amount: result.text, amountMinor, applyError: null };
  } catch (error) {
    const code = error instanceof CalculationFailure ? error.code : "overflow";
    return code === "incomplete"
      ? { ...unavailable, status: "incomplete" }
      : { ...unavailable, status: "error", code };
  }
}
