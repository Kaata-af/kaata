// A fixed 2026 goal, measured from one server snapshot. Do not roll the
// deadline into next year or use WAU/install growth as total-user growth.
export const USER_GOAL = 100_000;
export const USER_GOAL_DEADLINE = "2027-01-01T00:00:00+04:30";
const DEADLINE_MS = Date.parse(USER_GOAL_DEADLINE);
const DAY_MS = 86_400_000;
const MILESTONES = [1_000, 5_000, 10_000, 25_000, 50_000, 75_000, USER_GOAL];

type GoalSnapshot = {
  total: number;
  asOf: string;
  progress: number;
  remaining: number;
  daysRemaining: number;
  nextMilestone: number | null;
};

export type UserGoal =
  | { status: "unavailable" }
  | (GoalSnapshot & { status: "reached" | "closed" })
  | (GoalSnapshot & {
      status: "open";
      // null means a zero baseline or a rate too large to represent safely.
      weeklyRate: number | null;
      dailyAdditions: number;
      nextPeriodTotal: number;
      nextPeriodIsDeadline: boolean;
    });

function validSnapshotTime(value: string): number | null {
  // Require a timestamp with an explicit zone; Date.parse alone accepts local
  // dates and silently normalizes impossible dates such as February 30.
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts) return null;
  const [, y, m, d, h, min, sec, zone] = parts;
  const daysInMonth = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  if (
    Number(m) < 1 ||
    Number(m) > 12 ||
    Number(d) < 1 ||
    Number(d) > daysInMonth ||
    Number(h) > 23 ||
    Number(min) > 59 ||
    Number(sec) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function userGoal(total: number | undefined, asOf: string): UserGoal {
  const time = validSnapshotTime(asOf);
  if (total === undefined || !Number.isSafeInteger(total) || total < 0 || time === null) {
    return { status: "unavailable" };
  }
  const remaining = Math.max(0, USER_GOAL - total);
  const daysRemaining = Math.max(0, (DEADLINE_MS - time) / DAY_MS);
  const snapshot: GoalSnapshot = {
    total,
    asOf,
    progress: Math.min(100, (total / USER_GOAL) * 100),
    remaining,
    daysRemaining,
    nextMilestone: MILESTONES.find((milestone) => milestone > total) ?? null,
  };
  if (remaining === 0) return { ...snapshot, status: "reached" };
  if (daysRemaining === 0) return { ...snapshot, status: "closed" };

  const logGrowth = total > 0 ? Math.log(USER_GOAL / total) : null;
  const rate = logGrowth === null ? null : Math.expm1((logGrowth * 7) / daysRemaining) * 100;
  const nextPeriodIsDeadline = daysRemaining <= 7;
  // When starting from zero a percentage has no meaning. Use a linear net
  // acquisition requirement until there is a nonzero baseline.
  const nextPeriodTotal = nextPeriodIsDeadline
    ? USER_GOAL
    : total === 0
      ? Math.ceil((USER_GOAL * 7) / daysRemaining)
      : Math.min(USER_GOAL, Math.ceil(total * Math.exp((logGrowth! * 7) / daysRemaining)));
  return {
    ...snapshot,
    status: "open",
    weeklyRate:
      rate !== null && Number.isFinite(rate) && rate <= Number.MAX_SAFE_INTEGER ? rate : null,
    dailyAdditions: Math.ceil(remaining / daysRemaining),
    nextPeriodTotal,
    nextPeriodIsDeadline,
  };
}

export function requiredRateLabel(rate: number): string {
  // Round UP so the displayed requirement never promises a lower pace than
  // the math needs. Counts and next milestones always use full precision.
  return `${(Math.ceil(rate * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function goalProgressLabel(progress: number): string {
  if (progress > 0 && progress < 0.01) return "<0.01%";
  // Do not round an unfinished goal up to 100%.
  return `${(Math.floor(progress * 100) / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}%`;
}
