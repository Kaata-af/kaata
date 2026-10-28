/** Personal delivery choices. These never change a tally or its review state. */
export type NotificationPolicy = {
  enabled: boolean;
  tallies: boolean;
  reviews: boolean;
  cancellations: boolean;
  connections: boolean;
  reminders: boolean;
  sound: boolean;
  vibration: boolean;
  previews: "name" | "full" | "private";
  foreground: boolean;
  review_actions: boolean;
  quiet_hours: {
    enabled: boolean;
    start_minute: number;
    end_minute: number;
    allow_reminders: boolean;
  };
  time_zone: string;
};

export type NotificationOverrides = Partial<
  Omit<NotificationPolicy, "quiet_hours" | "time_zone">
> & {
  bypass_quiet_hours?: boolean;
};

export function notificationTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function defaultNotificationPolicy(): NotificationPolicy {
  return {
    enabled: true,
    tallies: true,
    reviews: true,
    cancellations: true,
    connections: true,
    reminders: true,
    sound: true,
    vibration: true,
    previews: "name",
    foreground: false,
    review_actions: true,
    quiet_hours: {
      enabled: false,
      start_minute: 22 * 60,
      end_minute: 7 * 60,
      allow_reminders: true,
    },
    time_zone: notificationTimeZone(),
  };
}

const BOOLS = [
  "enabled",
  "tallies",
  "reviews",
  "cancellations",
  "connections",
  "reminders",
  "sound",
  "vibration",
  "foreground",
  "review_actions",
] as const;
const minute = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1440;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Corrupt/older preferences cannot invent invalid time windows or values. */
export function normalizeNotificationPolicy(value: unknown): NotificationPolicy {
  const defaults = defaultNotificationPolicy(),
    raw = object(value);
  const result = { ...defaults };
  for (const key of BOOLS) if (typeof raw[key] === "boolean") result[key] = raw[key] as boolean;
  if (raw.previews === "full" || raw.previews === "name" || raw.previews === "private")
    result.previews = raw.previews;
  const quiet = object(raw.quiet_hours);
  result.quiet_hours = {
    enabled: quiet.enabled === true,
    start_minute: minute(quiet.start_minute)
      ? quiet.start_minute
      : defaults.quiet_hours.start_minute,
    end_minute: minute(quiet.end_minute) ? quiet.end_minute : defaults.quiet_hours.end_minute,
    allow_reminders: typeof quiet.allow_reminders === "boolean" ? quiet.allow_reminders : true,
  };
  if (result.quiet_hours.start_minute === result.quiet_hours.end_minute)
    result.quiet_hours.enabled = false;
  // Follow this phone's zone when travelling; server delivery receives this snapshot.
  result.time_zone = notificationTimeZone();
  return result;
}

export function normalizeNotificationOverrides(value: unknown): NotificationOverrides {
  const raw = object(value),
    result: NotificationOverrides = {};
  for (const key of BOOLS) if (typeof raw[key] === "boolean") result[key] = raw[key] as boolean;
  if (raw.previews === "full" || raw.previews === "name" || raw.previews === "private")
    result.previews = raw.previews;
  if (typeof raw.bypass_quiet_hours === "boolean")
    result.bypass_quiet_hours = raw.bypass_quiet_hours;
  return result;
}

export function mergeNotificationPolicy(
  global: NotificationPolicy,
  overrides?: NotificationOverrides | null,
): NotificationPolicy {
  const merged = normalizeNotificationPolicy({ ...global, ...overrides });
  merged.enabled = global.enabled && (overrides?.enabled ?? true);
  if (overrides?.bypass_quiet_hours) merged.quiet_hours.enabled = false;
  return merged;
}

export function quietNotificationTime(policy: NotificationPolicy, at = new Date()): boolean {
  if (!policy.quiet_hours.enabled) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.time_zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const now =
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value);
  return quietNotificationMinute(policy, now);
}

export function quietNotificationMinute(policy: NotificationPolicy, now: number): boolean {
  if (!policy.quiet_hours.enabled) return false;
  const { start_minute: start, end_minute: end } = policy.quiet_hours;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function notificationAllowed(
  policy: NotificationPolicy,
  kind: string,
  at = new Date(),
): boolean {
  if (!policy.enabled) return false;
  const category =
    kind === "customer_reminder"
      ? "reminders"
      : kind === "entry_created"
        ? "tallies"
        : kind === "entry_accepted" || kind === "entry_rejected"
          ? "reviews"
          : kind === "entry_voided"
            ? "cancellations"
            : "connections";
  if (!policy[category]) return false;
  return (
    (category === "reminders" && policy.quiet_hours.allow_reminders) ||
    !quietNotificationTime(policy, at)
  );
}

export function notificationChannel(
  policy: Pick<NotificationPolicy, "sound" | "vibration">,
  reminder = false,
): string {
  return `${reminder ? "customer-reminders" : "tab-updates"}-s${Number(policy.sound)}-v${Number(policy.vibration)}`;
}

export function parseNotificationTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]),
    minutes = Number(match[2]);
  return hour < 24 && minutes < 60 ? hour * 60 + minutes : null;
}

export function formatNotificationTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
