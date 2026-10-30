/** Alert rules compare exact balances in their own denominations. They never
 * participate in credit admission or convert one currency into another. */
export type CreditAlertCondition = { currency: string; threshold_minor: number };
export type CreditAlertDirection = "collect" | "pay";
export type CreditAlertGroup = {
  direction: CreditAlertDirection;
  conditions: CreditAlertCondition[];
};
export type CreditAlertPolicy = {
  relationship_id: string;
  groups: CreditAlertGroup[];
  updated_at_ms: number;
};
export type CreditAlertBalances = Readonly<Record<string, number | null | undefined>>;
export type CreditAlertMatch = "matched" | "clear" | "unknown";

export function validCreditAlertGroups(value: unknown): value is CreditAlertGroup[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((group: unknown) => {
      if (!group || typeof group !== "object") return false;
      const g = group as CreditAlertGroup;
      return (
        (g.direction === "collect" || g.direction === "pay") &&
        Array.isArray(g.conditions) &&
        g.conditions.length >= 1 &&
        g.conditions.length <= 20 &&
        new Set(g.conditions.map((c) => c?.currency)).size === g.conditions.length &&
        g.conditions.every(
          (c) =>
            c != null &&
            typeof c === "object" &&
            typeof c.currency === "string" &&
            /^[A-Z]{3}$/.test(c.currency) &&
            Number.isSafeInteger(c.threshold_minor) &&
            c.threshold_minor > 0 &&
            c.threshold_minor <= 999999999999,
        )
      );
    })
  );
}

export function validCreditAlertPolicy(value: unknown): value is CreditAlertPolicy {
  if (!value || typeof value !== "object") return false;
  const p = value as CreditAlertPolicy;
  return (
    typeof p.relationship_id === "string" &&
    p.relationship_id.length > 0 &&
    Number.isSafeInteger(p.updated_at_ms) &&
    p.updated_at_ms >= 0 &&
    validCreditAlertGroups(p.groups)
  );
}

/** A missing or unverified balance stays unknown. A known false condition can
 * still clear its AND group; a known matching alternative satisfies the OR. */
export function evaluateCreditAlertDirection(
  policy: CreditAlertPolicy | null | undefined,
  balances: CreditAlertBalances,
  direction: CreditAlertDirection,
): CreditAlertMatch {
  let unknown = false;
  for (const group of policy?.groups ?? []) {
    if (group.direction !== direction) continue;
    let groupUnknown = false;
    let clear = false;
    for (const condition of group.conditions) {
      const balance = balances[condition.currency];
      if (balance == null || !Number.isSafeInteger(balance)) {
        groupUnknown = true;
        continue;
      }
      const exposure = direction === "collect" ? balance : -balance;
      if (exposure < condition.threshold_minor) clear = true;
    }
    if (clear) continue;
    if (!groupUnknown) return "matched";
    unknown = true;
  }
  return unknown ? "unknown" : "clear";
}

export function matchedCreditAlertDirections(
  policy: CreditAlertPolicy | null | undefined,
  balances: CreditAlertBalances,
): CreditAlertDirection[] {
  return (["collect", "pay"] as const).filter(
    (direction) => evaluateCreditAlertDirection(policy, balances, direction) === "matched",
  );
}

export function evaluateCreditAlertDirections(
  policy: CreditAlertPolicy | null | undefined,
  balances: CreditAlertBalances,
): Record<CreditAlertDirection, CreditAlertMatch> {
  return {
    collect: evaluateCreditAlertDirection(policy, balances, "collect"),
    pay: evaluateCreditAlertDirection(policy, balances, "pay"),
  };
}

/** Array order and server timestamps do not change the meaning of a rule. */
export function creditAlertFingerprint(policy: CreditAlertPolicy | null | undefined): string {
  return JSON.stringify(
    (policy?.groups ?? [])
      .map((group) => ({
        direction: group.direction,
        conditions: [...group.conditions].sort(
          (a, b) => a.currency.localeCompare(b.currency) || a.threshold_minor - b.threshold_minor,
        ),
      }))
      .map((group) => JSON.stringify(group))
      .sort(),
  );
}

/** Mirrors live independent-limit warnings: warn on increasing exposure when
 * an inclusive combined rule is met, while repayments remain unimpeded. */
export function creditAlertExceeded(
  policy: CreditAlertPolicy | null | undefined,
  before: CreditAlertBalances,
  after: CreditAlertBalances,
): boolean {
  return (policy?.groups ?? []).some((group) => {
    const single = policy ? { ...policy, groups: [group] } : null;
    return (
      evaluateCreditAlertDirection(single, after, group.direction) === "matched" &&
      group.conditions.some(({ currency }) => {
        const a = after[currency],
          b = before[currency];
        return (
          a != null &&
          b != null &&
          Number.isSafeInteger(a) &&
          Number.isSafeInteger(b) &&
          (group.direction === "collect" ? a > b : a < b)
        );
      })
    );
  });
}
