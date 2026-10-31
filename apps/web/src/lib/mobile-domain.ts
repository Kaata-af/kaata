// These modules are platform-independent release logic. Both clients use the
// same currency catalog and exact calculator instead of maintaining two rules.
export {
  CURRENCIES,
  getCurrencyNameForLocale,
  searchCurrencies,
  type Currency,
} from "../../../mobile/lib/currency-catalog";
export {
  evaluateCalculation,
  normalizeCalculationInput,
  calculationOperand,
  MAX_CALCULATION_LENGTH,
} from "../../../mobile/lib/calculator";
export {
  calculatorDraft,
  calculatorKey,
  calculateDraft,
  selectCalculation,
  recallCalculationValue,
  rememberCalculation,
} from "../../../mobile/lib/calculator-input";
