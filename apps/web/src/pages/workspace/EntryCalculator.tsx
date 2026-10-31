import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n, type Lang } from "../../lib/i18n";
import {
  calculatorDraft,
  calculatorKey,
  evaluateCalculation,
  MAX_CALCULATION_LENGTH,
  normalizeCalculationInput,
  selectCalculation,
} from "../../lib/mobile-domain";
import "./EntryCalculator.css";

const en = {
  open: "Use calculator",
  close: "Close calculator",
  expression: "Calculation",
  placeholder: "e.g. 25 × 3 + 10%",
  result: "Result",
  empty: "Enter a calculation to see the result.",
  incomplete: "Finish the calculation to use its result.",
  invalid: "Check the calculation.",
  division: "Cannot divide by zero.",
  complex: "Keep calculations to 256 characters and fewer parentheses.",
  large: "This amount is too large.",
  positive: "Use a result of at least 0.01.",
  rounded: "Rounded to 2 decimal places when used.",
  hint: "Calculate here, then use the result as your entry amount.",
  cancel: "Cancel",
  apply: "Use amount",
  clear: "Clear calculation",
  delete: "Backspace",
  group: "Parentheses",
  percent: "Percent",
  divide: "Divide",
  multiply: "Multiply",
  subtract: "Subtract",
  add: "Add",
  sign: "Change sign",
  decimal: "Decimal point",
  equals: "Calculate result",
};
type Copy = { [K in keyof typeof en]: string };
const fa: Copy = {
  open: "استفاده از ماشین‌حساب",
  close: "بستن ماشین‌حساب",
  expression: "محاسبه",
  placeholder: "مثلاً 25 × 3 + 10%",
  result: "نتیجه",
  empty: "برای دیدن نتیجه، یک محاسبه وارد کنید.",
  incomplete: "برای استفاده از نتیجه، محاسبه را تکمیل کنید.",
  invalid: "محاسبه را بررسی کنید.",
  division: "تقسیم بر صفر ممکن نیست.",
  complex: "محاسبه را تا ۲۵۶ نویسه و با قوس‌های کمتر نگه دارید.",
  large: "این مبلغ بیش از حد بزرگ است.",
  positive: "نتیجه باید حداقل ۰٫۰۱ باشد.",
  rounded: "هنگام استفاده تا ۲ رقم اعشار گرد می‌شود.",
  hint: "اینجا محاسبه کنید، سپس نتیجه را به‌عنوان مبلغ ثبت استفاده کنید.",
  cancel: "لغو",
  apply: "استفاده از مبلغ",
  clear: "پاک کردن محاسبه",
  delete: "پاک کردن رقم قبلی",
  group: "قوس‌ها",
  percent: "فیصد",
  divide: "تقسیم",
  multiply: "ضرب",
  subtract: "تفریق",
  add: "جمع",
  sign: "تغییر علامت",
  decimal: "ممیز",
  equals: "محاسبۀ نتیجه",
};
const ps: Copy = {
  open: "ماشین حساب وکاروئ",
  close: "ماشین حساب وتړئ",
  expression: "محاسبه",
  placeholder: "لکه 25 × 3 + 10%",
  result: "پایله",
  empty: "د پایلې د لیدلو لپاره محاسبه ولیکئ.",
  incomplete: "د پایلې د کارولو لپاره محاسبه بشپړه کړئ.",
  invalid: "محاسبه وګورئ.",
  division: "پر صفر وېشل ممکن نه دي.",
  complex: "محاسبه تر ۲۵۶ تورو او لږو قوسونو پورې محدوده کړئ.",
  large: "دا اندازه ډېره لویه ده.",
  positive: "پایله باید لږ تر لږه ۰٫۰۱ وي.",
  rounded: "د کارولو پر مهال تر ۲ اعشاري ځایونو پورې ګردېږي.",
  hint: "دلته محاسبه وکړئ، بیا پایله د خپل ثبت د اندازې په توګه وکاروئ.",
  cancel: "لغوه",
  apply: "اندازه وکاروئ",
  clear: "محاسبه پاکه کړئ",
  delete: "مخکینی رقم پاک کړئ",
  group: "قوسونه",
  percent: "سلنه",
  divide: "وېشل",
  multiply: "ضرب",
  subtract: "منفي",
  add: "جمع",
  sign: "نښه بدله کړئ",
  decimal: "اعشاري ټکی",
  equals: "پایله محاسبه کړئ",
};
const copies: Record<Lang, Copy> = { en, fa, ps };
const keys = [
  ["AC", "()", "%", "delete"],
  ["7", "8", "9", "/"],
  ["4", "5", "6", "*"],
  ["1", "2", "3", "-"],
  ["sign", "0", ".", "+"],
];
const glyphs: Record<string, string> = {
  "()": "( )",
  delete: "⌫",
  "/": "÷",
  "*": "×",
  "-": "−",
  sign: "+/−",
};
const keyLabels = {
  AC: "clear",
  "()": "group",
  "%": "percent",
  delete: "delete",
  "/": "divide",
  "*": "multiply",
  "-": "subtract",
  "+": "add",
  sign: "sign",
  ".": "decimal",
  "=": "equals",
} as const;

export function EntryCalculator({
  amount,
  onApply,
  disabled = false,
  currency,
}: {
  amount: string;
  onApply: (amount: string) => void;
  disabled?: boolean;
  currency?: string;
}) {
  const { lang } = useI18n();
  const copy = copies[lang];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => calculatorDraft());
  const currentDraft = useRef(draft);
  const input = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusInput = useRef(false);
  const id = useId();
  const result = evaluateCalculation(draft.expression);
  const feedback =
    result.status === "incomplete"
      ? draft.expression
        ? copy.incomplete
        : copy.empty
      : result.status === "error"
        ? result.code === "division_by_zero"
          ? copy.division
          : result.code === "too_complex"
            ? copy.complex
            : result.code === "overflow"
              ? copy.large
              : copy.invalid
        : !result.canApply
          ? result.applyError === "non_positive"
            ? copy.positive
            : copy.large
          : result.rounded
            ? copy.rounded
            : "";
  const invalid = result.status === "error" || (result.status === "valid" && !result.canApply);

  const change = (next: ReturnType<typeof calculatorDraft>, focus = false) => {
    currentDraft.current = next;
    focusInput.current = focus;
    setDraft(next);
  };

  useLayoutEffect(() => {
    if (!open || !input.current) return;
    if (focusInput.current) input.current.focus({ preventScroll: true });
    input.current.setSelectionRange(draft.selection.start, draft.selection.end);
    focusInput.current = false;
  }, [open, draft]);

  const close = () => {
    setOpen(false);
    change(calculatorDraft());
    toggle.current?.focus({ preventScroll: true });
  };
  const press = (key: string) => {
    if (disabled) return;
    const nativeSelection = input.current;
    const selected =
      nativeSelection && document.activeElement === nativeSelection
        ? selectCalculation(
            currentDraft.current,
            nativeSelection.selectionStart ?? 0,
            nativeSelection.selectionEnd ?? 0,
          )
        : currentDraft.current;
    const next = calculatorKey(selected, key);
    // Keep an over-limit calculation visibly invalid instead of accepting a
    // truncated prefix as a different, saveable amount. Delete/clear can fix it.
    if (
      next.expression.length > MAX_CALCULATION_LENGTH + 1 &&
      next.expression.length > selected.expression.length
    )
      return;
    change(next, true);
  };
  const keyboard = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const key = normalizeCalculationInput(event.key);
    if (
      event.key === "Enter" ||
      key === "=" ||
      event.key === "Backspace" ||
      /^[0-9.+*/%()\-]$/.test(key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      press(event.key === "Enter" ? "=" : event.key === "Backspace" ? "delete" : key);
    }
  };
  const apply = () => {
    if (disabled) return;
    const value = evaluateCalculation(currentDraft.current.expression);
    if (value.status !== "valid" || !value.canApply) return;
    onApply(value.amount);
    close();
  };

  return (
    <div
      className="entry-calculator"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="entry-calculator-toggle"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          if (open) close();
          else {
            change(calculatorDraft(amount), true);
            setOpen(true);
          }
        }}
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <rect x="4" y="2" width="12" height="16" rx="2" />
          <path d="M7 5h6M7 9h1m4 0h1m-6 3h1m4 0h1m-6 3h1m4 0h1" />
        </svg>
        {open ? copy.close : copy.open}
      </button>
      {open && (
        <section id={`${id}-panel`} className="entry-calculator-panel" aria-label={copy.expression}>
          <label htmlFor={`${id}-expression`}>{copy.expression}</label>
          <input
            ref={input}
            id={`${id}-expression`}
            className="entry-calculator-expression"
            type="text"
            dir="ltr"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draft.expression}
            disabled={disabled}
            placeholder={copy.placeholder}
            aria-invalid={invalid}
            aria-describedby={`${id}-feedback`}
            onKeyDown={keyboard}
            onSelect={(event) => {
              const element = event.currentTarget;
              currentDraft.current = selectCalculation(
                currentDraft.current,
                element.selectionStart ?? 0,
                element.selectionEnd ?? 0,
              );
            }}
            onChange={(event) => {
              const element = event.currentTarget;
              const next = calculatorDraft(element.value);
              change(
                selectCalculation(
                  next,
                  normalizeCalculationInput(element.value.slice(0, element.selectionStart ?? 0))
                    .length,
                  normalizeCalculationInput(element.value.slice(0, element.selectionEnd ?? 0))
                    .length,
                ),
              );
            }}
          />
          <div className="entry-calculator-result">
            <span>{copy.result}</span>
            <output htmlFor={`${id}-expression`} dir="ltr" aria-live="polite">
              {result.status === "valid" ? result.display : "—"}
              {currency && <small>{currency}</small>}
            </output>
          </div>
          <p
            id={`${id}-feedback`}
            className={`entry-calculator-feedback${invalid ? " is-error" : ""}`}
            aria-live="polite"
          >
            {feedback || "\u00a0"}
          </p>
          <div className="entry-calculator-keys" dir="ltr">
            {keys.flat().map((key) => (
              <button
                key={key}
                type="button"
                disabled={disabled}
                className={
                  /[+*/%\-]/.test(key) || key === "sign" || key === "()" ? "is-operator" : ""
                }
                aria-label={key in keyLabels ? copy[keyLabels[key as keyof typeof keyLabels]] : key}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => press(key)}
              >
                {glyphs[key] ?? key}
              </button>
            ))}
          </div>
          <div className="entry-calculator-actions">
            <button
              type="button"
              disabled={disabled}
              className="entry-calculator-equals"
              aria-label={copy.equals}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => press("=")}
            >
              =
            </button>
            <button type="button" disabled={disabled} onClick={close}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="entry-calculator-apply"
              disabled={disabled || !result.canApply}
              onClick={apply}
            >
              {copy.apply}
            </button>
          </div>
          <p className="entry-calculator-hint">{copy.hint}</p>
        </section>
      )}
    </div>
  );
}
