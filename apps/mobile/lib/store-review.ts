import { isRunningInExpoGo } from "expo";
import * as Application from "expo-application";
import { Platform } from "react-native";
import { getAppMeta, setAppMeta } from "./db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getInstallIdSync } from "./db-tx";
import { getInstalledAtUnixMs } from "./install-id";

export type StoreReviewContext = {
  installId: string;
  accountId: string | null;
  vaultId: string | null;
};

type Attempt = { at: number; version: string };
type ReviewState = {
  schema: 1;
  installId: string;
  accountId: string | null;
  firstObservedAt: number;
  tallyCount: number;
  recentEntryIds: string[];
  activeDays: number[];
  attempts: Attempt[];
  quietUntil: number;
};
type NativeReview = Pick<typeof import("expo-store-review"), "isAvailableAsync" | "requestReview">;
export type StoreReviewDependencies = {
  now: () => number;
  currentContext: () => StoreReviewContext;
  supportedEnvironment: () => boolean;
  appVersion: () => string | null;
  installedAt: () => Promise<number | null>;
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string) => Promise<void>;
  nativeReview: () => Promise<NativeReview>;
};

const DAY = 24 * 60 * 60 * 1000;
const COOLDOWN = 90 * DAY;
const YEAR = 365 * DAY;
const OPPORTUNITY_LIFETIME = 10 * 60 * 1000;
const sameContext = (a: StoreReviewContext, b: StoreReviewContext) =>
  a.installId === b.installId && a.accountId === b.accountId && a.vaultId === b.vaultId;
const stateKey = (installId: string) => `store_review:v1:${installId}`;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function parseState(
  raw: string | null,
  installId: string,
  accountId: string | null,
  now: number,
): ReviewState {
  const fresh = (quietUntil = 0): ReviewState => ({
    schema: 1,
    installId,
    accountId,
    firstObservedAt: now,
    tallyCount: 0,
    recentEntryIds: [],
    activeDays: [],
    attempts: [],
    quietUntil,
  });
  if (raw === null) return fresh();
  try {
    const state = JSON.parse(raw) as ReviewState;
    if (
      state.schema !== 1 ||
      state.installId !== installId ||
      (state.accountId !== null && typeof state.accountId !== "string") ||
      !timestamp(state.firstObservedAt) ||
      !Number.isSafeInteger(state.tallyCount) ||
      state.tallyCount < 0 ||
      !Array.isArray(state.recentEntryIds) ||
      state.recentEntryIds.length > 32 ||
      state.recentEntryIds.some((id) => typeof id !== "string" || !id) ||
      !Array.isArray(state.activeDays) ||
      state.activeDays.length > 365 ||
      state.activeDays.some((day) => !Number.isSafeInteger(day) || day < 0) ||
      new Set(state.activeDays).size !== state.activeDays.length ||
      !Array.isArray(state.attempts) ||
      state.attempts.length > 16 ||
      state.attempts.some(
        (attempt) =>
          !attempt ||
          !timestamp(attempt.at) ||
          typeof attempt.version !== "string" ||
          !attempt.version,
      ) ||
      !Number.isFinite(state.quietUntil) ||
      state.quietUntil < 0
    )
      return fresh(now + COOLDOWN);
    // Shared phones must not invite a new person's first tally to review using
    // somebody else's week of activity. Store-wide request limits still apply.
    return state.accountId === accountId
      ? state
      : { ...fresh(state.quietUntil), attempts: state.attempts };
  } catch {
    // Damaged metadata must not erase a previous cooldown and immediately
    // expose someone to another request. It is unrelated to their ledger.
    return fresh(now + COOLDOWN);
  }
}

function eligible(state: ReviewState, installedAt: number | null, now: number, version: string) {
  if (!timestamp(now)) return false;
  const firstUse = Math.max(state.firstObservedAt, timestamp(installedAt) ? installedAt : 0);
  if (
    state.tallyCount < 10 ||
    state.activeDays.length < 7 ||
    now - firstUse < 7 * DAY ||
    now < state.quietUntil
  )
    return false;
  // A future timestamp also blocks after a backwards device-clock change.
  if (state.attempts.some((attempt) => now - attempt.at < COOLDOWN)) return false;
  if (state.attempts.some((attempt) => attempt.version === version)) return false;
  return state.attempts.filter((attempt) => now - attempt.at < YEAR).length < 3;
}

/** Native stores do not report whether a dialog appeared or a rating was sent.
 * We persist attempts only. Every operation is best-effort and ledger-free. */
export function createStoreReviewService(deps: StoreReviewDependencies) {
  type Opportunity = { id: string; context: StoreReviewContext; at: number };
  let opportunity: Opportunity | null = null;
  let nextId = 0;
  let serial: Promise<void> = Promise.resolve();
  let requesting: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const current = (context: StoreReviewContext) => {
    try {
      return (
        !!context.installId &&
        deps.supportedEnvironment() &&
        sameContext(context, deps.currentContext())
      );
    } catch {
      return false;
    }
  };
  const version = () => {
    const value = deps.appVersion();
    return value && /^\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(value) ? value : null;
  };
  const ready = (context: StoreReviewContext, id: string, isReady: () => boolean) => {
    try {
      return getReviewOpportunity(context) === id && current(context) && isReady();
    } catch {
      return false;
    }
  };
  const queue = (work: () => Promise<void>) => {
    const result = serial.then(work).catch(() => undefined);
    serial = result;
    return result;
  };
  function getReviewOpportunity(context: StoreReviewContext): string | null {
    // Context cleanup discards old opportunities even if the user later
    // returns to the same account or Kaata within the ten-minute window.
    if (opportunity && !current(opportunity.context)) opportunity = null;
    if (!opportunity || !current(context) || !sameContext(context, opportunity.context))
      return null;
    const age = deps.now() - opportunity.at;
    if (!Number.isFinite(age) || age < 0 || age > OPPORTUNITY_LIFETIME) {
      opportunity = null;
      return null;
    }
    return opportunity.id;
  }
  function dismissReviewOpportunity(id: string): void {
    if (opportunity?.id === id) opportunity = null;
  }
  function noteReviewableTally(context: StoreReviewContext, entryId: string): void {
    if (!entryId || !current(context)) return;
    const captured = { ...context };
    let savedAt: number;
    try {
      savedAt = deps.now();
    } catch {
      return;
    }
    if (!timestamp(savedAt)) return;
    void queue(async () => {
      if (!current(captured)) return;
      const raw = await deps.read(stateKey(captured.installId));
      if (!current(captured)) return;
      const state = parseState(raw, captured.installId, captured.accountId, savedAt);
      if (state.recentEntryIds.includes(entryId)) return;
      state.tallyCount = Math.min(Number.MAX_SAFE_INTEGER, state.tallyCount + 1);
      state.recentEntryIds = [...state.recentEntryIds, entryId].slice(-32);
      const day = Math.floor(savedAt / DAY);
      state.activeDays = [...new Set([...state.activeDays, day])]
        .filter((activeDay) => activeDay >= day - 364)
        .slice(-365);
      await deps.write(stateKey(captured.installId), JSON.stringify(state));
      if (!current(captured)) return;
      const installedAt = await deps.installedAt();
      if (!current(captured)) return;
      const appVersion = version();
      const publishedAt = deps.now();
      if (
        publishedAt < savedAt ||
        publishedAt - savedAt > OPPORTUNITY_LIFETIME ||
        !appVersion ||
        !eligible(state, installedAt, publishedAt, appVersion)
      )
        return;
      opportunity = {
        id: `${captured.installId}:${++nextId}`,
        context: captured,
        at: savedAt,
      };
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A screen listener cannot turn a saved tally into an error.
        }
      }
    });
  }
  function requestReviewOpportunity(
    context: StoreReviewContext,
    id: string,
    isReady: () => boolean,
  ): Promise<void> {
    if (requesting) return requesting;
    const captured = { ...context };
    requesting = queue(async () => {
      if (!ready(captured, id, isReady)) return;
      const raw = await deps.read(stateKey(captured.installId));
      if (!ready(captured, id, isReady)) return;
      const now = deps.now();
      const state = parseState(raw, captured.installId, captured.accountId, now);
      const installedAt = await deps.installedAt();
      if (!ready(captured, id, isReady)) return;
      const appVersion = version();
      if (!appVersion || !eligible(state, installedAt, deps.now(), appVersion)) return;
      const native = await deps.nativeReview();
      if (!ready(captured, id, isReady)) return;
      const available = await native.isAvailableAsync();
      if (!ready(captured, id, isReady)) return;
      if (!available) {
        dismissReviewOpportunity(id);
        return;
      }
      // Stamp before requesting, including when the store silently declines.
      // Retain versions outside the yearly cap window to avoid same-version
      // repeats even when someone uses one app version for a long time.
      state.attempts = [...state.attempts, { at: deps.now(), version: appVersion }].slice(-16);
      await deps.write(stateKey(captured.installId), JSON.stringify(state));
      if (!ready(captured, id, isReady)) return;
      dismissReviewOpportunity(id);
      await native.requestReview();
    }).finally(() => {
      dismissReviewOpportunity(id);
      requesting = null;
    });
    return requesting;
  }
  return {
    noteReviewableTally,
    getReviewOpportunity,
    subscribeReviewOpportunities(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismissReviewOpportunity,
    requestReviewOpportunity,
  };
}

const service = createStoreReviewService({
  now: Date.now,
  currentContext: () => ({
    installId: getInstallIdSync(),
    accountId: getAccountIdSync(),
    vaultId: getActiveVaultIdSyncMaybe(),
  }),
  supportedEnvironment: () =>
    !(typeof __DEV__ !== "undefined" && __DEV__) &&
    (Platform.OS === "ios" || Platform.OS === "android") &&
    !isRunningInExpoGo() &&
    Application.applicationId === "af.kaata.app",
  appVersion: () => Application.nativeApplicationVersion,
  installedAt: getInstalledAtUnixMs,
  read: getAppMeta,
  write: setAppMeta,
  nativeReview: () => import("expo-store-review"),
});
export const {
  noteReviewableTally,
  getReviewOpportunity,
  subscribeReviewOpportunities,
  dismissReviewOpportunity,
  requestReviewOpportunity,
} = service;
