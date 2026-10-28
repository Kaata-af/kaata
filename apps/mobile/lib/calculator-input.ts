import { calculationOperand, evaluateCalculation, normalizeCalculationInput } from "./calculator";

export type CalculatorDraft = {
  expression: string;
  selection: { start: number; end: number };
  evaluated: boolean;
  repeat: { operator: string; operand: string } | null;
};

export type CalculatorRecord = { expression: string; result: string };

export function calculatorDraft(expression = ""): CalculatorDraft {
  const normalized = normalizeCalculationInput(expression);
  return {
    expression: normalized,
    selection: { start: normalized.length, end: normalized.length },
    evaluated: false,
    repeat: null,
  };
}

export function selectCalculation(
  draft: CalculatorDraft,
  start: number,
  end: number,
): CalculatorDraft {
  const from = Math.max(
    0,
    Math.min(draft.expression.length, Number.isFinite(start) ? Math.floor(start) : 0),
  );
  return {
    ...draft,
    selection: {
      start: from,
      end: Math.max(
        from,
        Math.min(draft.expression.length, Number.isFinite(end) ? Math.floor(end) : from),
      ),
    },
  };
}

function insert(draft: CalculatorDraft, text: string): CalculatorDraft {
  const { start, end } = draft.selection;
  const expression = draft.expression.slice(0, start) + text + draft.expression.slice(end);
  const next = calculatorDraft(expression);
  // Normalization trims pasted whitespace. Never leave the native caret beyond
  // the normalized expression, or a subsequent backspace can delete nothing.
  const leadingWhitespace = expression.length - expression.trimStart().length;
  const caret = start + text.length - leadingWhitespace;
  return selectCalculation(next, caret, caret);
}

function repeatOperation(expression: string): CalculatorDraft["repeat"] {
  expression = expression.replace(/\s/g, "");
  let depth = 0,
    additive = -1,
    multiplicative = -1;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && i > 0 && /[\d.)%]/.test(expression[i - 1])) {
      if (char === "+" || char === "-") additive = i;
      if (char === "*" || char === "/") multiplicative = i;
    }
  }
  const index = additive >= 0 ? additive : multiplicative;
  return index < 0 ? null : { operator: expression[index], operand: expression.slice(index + 1) };
}

function operandSelection(draft: CalculatorDraft): CalculatorDraft {
  if (draft.selection.start !== draft.selection.end) return draft;
  const text = draft.expression;
  let start = draft.selection.start,
    end = start;
  while (start > 0 && /\s/.test(text[start - 1])) start--;
  let tail = start;
  while (tail > 0 && text[tail - 1] === "%") tail--;
  if (text[tail - 1] === ")") {
    let depth = 1;
    start = tail - 1;
    while (start > 0 && depth > 0) {
      start--;
      if (text[start] === ")") depth++;
      else if (text[start] === "(") depth--;
    }
  } else {
    start = tail;
    while (start > 0 && /[\d.]/.test(text[start - 1])) start--;
    while (end < text.length && /[\d.]/.test(text[end])) end++;
    while (end < text.length && text[end] === "%") end++;
  }
  while (end < text.length && text[end] === "%") end++;
  if (start === end) return selectCalculation(draft, start, end);
  let sign = start - 1;
  while (sign >= 0 && /\s/.test(text[sign])) sign--;
  if (text[sign] === "-" || text[sign] === "+") {
    let previous = sign - 1;
    while (previous >= 0 && /\s/.test(text[previous])) previous--;
    if (previous < 0 || /[+*/(\-]/.test(text[previous])) start = sign;
  }
  return selectCalculation(draft, start, end);
}

function singleOperand(expression: string): boolean {
  let atom = expression
    .trim()
    .replace(/^[+\-]+\s*/, "")
    .replace(/%+$/, "")
    .trim();
  if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(atom)) return true;
  if (!atom.startsWith("(") || !atom.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < atom.length; i++) {
    if (atom[i] === "(") depth++;
    else if (atom[i] === ")") depth--;
    if (depth === 0 && i < atom.length - 1) return false;
  }
  return depth === 0;
}

export function calculateDraft(draft: CalculatorDraft): CalculatorDraft {
  const result = evaluateCalculation(draft.expression);
  if (result.status !== "valid" || result.value === null) return draft;
  if (draft.evaluated && draft.repeat) {
    const expression = `${calculationOperand(result)}${draft.repeat.operator}${draft.repeat.operand}`;
    const next = calculatorDraft(expression);
    // A failed repeat is still the user's new calculation. Keeping the old
    // successful draft would leave its stale amount eligible for saving.
    if (evaluateCalculation(expression).status !== "valid") return next;
    return { ...next, evaluated: true, repeat: draft.repeat };
  }
  return { ...draft, evaluated: true, repeat: repeatOperation(draft.expression) };
}

export function calculatorKey(draft: CalculatorDraft, key: string): CalculatorDraft {
  if (key === "AC") return calculatorDraft();
  if (key === "=") return calculateDraft(draft);
  let current = draft;
  if (draft.evaluated) {
    const result = evaluateCalculation(draft.expression);
    const value = result.value ?? draft.expression;
    // Arithmetic continues the exact answer. Backspace deliberately edits the
    // displayed monetary answer, rather than an invisible rational expression.
    const continuation = result.status === "valid" ? calculationOperand(result) : value;
    current = calculatorDraft(
      key === "delete" ? value : /[+*/%\-]/.test(key) || key === "sign" ? continuation : "",
    );
  }
  if (key === "delete") {
    if (current.selection.start !== current.selection.end) return insert(current, "");
    if (current.selection.start === 0) return current;
    return insert(
      selectCalculation(current, current.selection.start - 1, current.selection.end),
      "",
    );
  }
  if (key === "sign") {
    const selected = operandSelection(current);
    const operand = current.expression.slice(selected.selection.start, selected.selection.end);
    if (!operand) {
      const before = current.expression.slice(0, current.selection.start);
      const sign = /([+\-])\s*$/.exec(before);
      if (sign) {
        const prefix = before.slice(0, sign.index).trimEnd();
        if (prefix === "" || /[+*/(\-]$/.test(prefix))
          return insert(
            selectCalculation(current, sign.index, current.selection.end),
            sign[1] === "-" ? "" : "-",
          );
      }
      return insert(current, "-");
    }
    if (operand.trimStart().startsWith("-") && singleOperand(operand))
      return insert(selected, operand.trimStart().slice(1).trimStart());
    return insert(
      selected,
      singleOperand(operand) ? `-${operand.replace(/^\+/, "")}` : `-(${operand})`,
    );
  }
  if (key === "()") {
    const { start, end } = current.selection;
    if (start !== end) return insert(current, `(${current.expression.slice(start, end)})`);
    const before = current.expression.slice(0, start).trimEnd();
    const unclosed = (before.match(/\(/g)?.length ?? 0) - (before.match(/\)/g)?.length ?? 0);
    key = unclosed > 0 && /(?:[\d)%]|\d\.)$/.test(before) ? ")" : "(";
  }
  const before = current.expression.slice(0, current.selection.start);
  const significantBefore = before.trimEnd();
  let operatorStart = significantBefore.length;
  if (/[+*/\-]$/.test(significantBefore)) {
    operatorStart--;
    while (operatorStart > 0 && /[+*/\-\s]/.test(significantBefore[operatorStart - 1]))
      operatorStart--;
  }
  if (current.selection.start === current.selection.end) {
    // Binary operators and percentages need an operand. A leading unary sign
    // or an opening group does not supply one.
    if (
      /^[*/]$/.test(key) &&
      !/(?:[\d)%]|\d\.)$/.test(significantBefore.slice(0, operatorStart).trimEnd())
    )
      return current;
    if (key === "%" && !/(?:[\d)%]|\d\.)$/.test(significantBefore)) return current;
  }
  if (key === ".") {
    const number = /[\d.]*$/.exec(before)?.[0] ?? "";
    const after = current.expression.slice(current.selection.end);
    const nextNumber = /^[\d.]*/.exec(after)?.[0] ?? "";
    if ((number + nextNumber).includes(".")) return current;
    if (number === "") key = "0.";
  }
  if (
    /^[+*/\-]$/.test(key) &&
    current.selection.start === current.selection.end &&
    /[+*/\-]$/.test(significantBefore)
  ) {
    // Minus after multiplication/division is a negative operand; other
    // accidental operator taps replace the pending operator.
    if (key === "-" && /[*/]\s*-\s*$/.test(significantBefore)) return current;
    if (key !== "-" || /[+\-]$/.test(significantBefore)) {
      current = selectCalculation(current, operatorStart, current.selection.end);
    }
  }
  if (key === "(" && /(?:[\d)%]|\d\.)$/.test(significantBefore)) key = "*(";
  if (/^\d/.test(key) && /[)%]$/.test(significantBefore)) key = `*${key}`;
  if (/^\d+$/.test(key) && current.expression === "0") current = selectCalculation(current, 0, 1);
  if (current.expression === "" && key === "00") key = "0";
  return insert(current, key);
}

export function recallCalculationValue(draft: CalculatorDraft, value: string): CalculatorDraft {
  if (draft.evaluated || draft.expression === "") return calculatorDraft(value);
  const selected = operandSelection(draft);
  return insert(selected, value.startsWith("-") ? `(${value})` : value);
}

export function rememberCalculation(
  history: CalculatorRecord[],
  record: CalculatorRecord,
): CalculatorRecord[] {
  if (history[0]?.expression === record.expression && history[0]?.result === record.result)
    return history;
  return [record, ...history].slice(0, 20);
}
