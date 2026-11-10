import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { getNetworkStateAsync } from "expo-network";
import { captureCurrentSession, SessionChangedError, type SessionSnapshot } from "./auth";
import {
  getAppMetaInTx,
  getDb,
  getSessionAccountIdSync,
  SESSION_ENDED_KEY,
  setAppMetaInTx,
} from "./db-tx";
import { googleDriveBackupProvider } from "./google-drive-backup";
import { icloudDriveBackupProvider } from "./icloud-backup";
import { DRIVE_BACKUP_FILE_LIMIT } from "./drive-backup";
import {
  PersonalBackupError,
  restoreDownloadedPersonalBackup,
  withPersonalBackupSession,
  withReadablePersonalBackup,
} from "./personal-backup";
import type { PersonalBackupCoverage, PersonalBackupErrorCode } from "./personal-backup-db";
import {
  PersonalCloudProviderError,
  type PersonalCloudConnection,
  type PersonalCloudCopy,
  type PersonalCloudProvider,
  type PersonalCloudProviderId,
} from "./personal-cloud-types";

export { PersonalBackupError, PersonalCloudProviderError };
export type { PersonalCloudProviderId };

type BackupError = PersonalBackupErrorCode | PersonalCloudProviderError["code"];
export type PersonalCloudStatus = {
  connection: PersonalCloudConnection;
  savedAt?: number;
  pending?: boolean;
  running?: boolean;
  error?: BackupError;
  coverage?: PersonalBackupCoverage;
};
type Settings = PersonalCloudStatus & {
  attemptedAt?: number;
  copyId?: string;
  revision?: number;
};
type SettingsByProvider = Partial<Record<PersonalCloudProviderId, Settings>>;
type BackupChoice = Readonly<Pick<PersonalCloudCopy, "name" | "createdAt">>;
const providers: Record<PersonalCloudProviderId, PersonalCloudProvider> = {
  googleDrive: googleDriveBackupProvider,
  icloudDrive: icloudDriveBackupProvider,
};
const destinations: PersonalCloudProviderId[] = ["googleDrive", "icloudDrive"];
const choices = new WeakMap<BackupChoice, {
  session: SessionSnapshot;
  id: PersonalCloudProviderId;
  scope: string;
  connection: PersonalCloudConnection;
  copy: PersonalCloudCopy;
}>();
const listeners = new Set<() => void>();
const MIN_BACKUP_INTERVAL = 15 * 60_000;
const RETRY_INTERVAL = 5 * 60_000;
const MAX_BACKUP_INTERVAL = 24 * 60 * 60_000;
let working = false;
let running: { session: SessionSnapshot; ids: PersonalCloudProviderId[] } | undefined;

function scopeFor(session: SessionSnapshot): string {
  return keyFor(`account:${session.accountId ?? "ninja"}`);
}

function keyFor(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(`kaata-personal-cloud:${value}`))).slice(0, 32);
}

function settingsKey(session: SessionSnapshot): string {
  return `personal_cloud_backup:${scopeFor(session)}`;
}

function offerDismissedKey(session: SessionSnapshot): string {
  return `personal_cloud_backup_offer_dismissed:${scopeFor(session)}`;
}

function sessionCanUseBackups(session: SessionSnapshot): boolean {
  return !!session.jwt === !!session.accountId && session.accountId === getSessionAccountIdSync();
}

export async function shouldOfferPersonalCloudBackup(expectedAccountId: string | null): Promise<boolean> {
  if (!destinations.some(isPersonalCloudBackupSupported)) return false;
  const session = await captureCurrentSession();
  if (session.accountId !== expectedAccountId || !sessionCanUseBackups(session)) return false;
  return withPersonalBackupSession(session, async () => {
    const db = await getDb();
    // Turning off the last destination leaves an empty settings object. That
    // is still a decision, as is a connection that now needs reconnecting.
    return (
      (await getAppMetaInTx(db, "install_retired")) !== "1" &&
      (await getAppMetaInTx(db, SESSION_ENDED_KEY)) !== "1" &&
      (await getAppMetaInTx(db, offerDismissedKey(session))) !== "1" &&
      (await getAppMetaInTx(db, settingsKey(session))) === null
    );
  });
}

export async function dismissPersonalCloudBackupOffer(expectedAccountId: string | null): Promise<void> {
  const session = await captureCurrentSession();
  if (session.accountId !== expectedAccountId || !sessionCanUseBackups(session))
    throw new PersonalBackupError("sessionChanged");
  await withPersonalBackupSession(session, async () => {
    const db = await getDb();
    if (
      (await getAppMetaInTx(db, "install_retired")) === "1" ||
      (await getAppMetaInTx(db, SESSION_ENDED_KEY)) === "1"
    ) throw new PersonalBackupError("sessionChanged");
    await setAppMetaInTx(db, offerDismissedKey(session), "1");
  });
  notify();
}

async function readSettings(session: SessionSnapshot): Promise<SettingsByProvider> {
  return withPersonalBackupSession(session, async () => {
    if (!sessionCanUseBackups(session)) return {};
    const db = await getDb();
    if (await getAppMetaInTx(db, "install_retired") === "1") return {};
    const raw = await getAppMetaInTx(db, settingsKey(session));
    try {
      const parsed = JSON.parse(raw ?? "{}") as SettingsByProvider;
      const result: SettingsByProvider = {};
      for (const id of destinations) {
        const value = parsed?.[id];
        if (typeof value?.connection?.id === "string" && value.connection.id) result[id] = value;
      }
      return result;
    } catch {
      return {};
    }
  });
}

async function saveSettings(session: SessionSnapshot, value: SettingsByProvider): Promise<void> {
  await withPersonalBackupSession(session, async () => {
    if (!sessionCanUseBackups(session)) throw new PersonalBackupError("sessionChanged");
    await setAppMetaInTx(await getDb(), settingsKey(session), JSON.stringify(value));
  });
  notify();
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A screen refresh cannot interrupt a backup.
    }
  }
}

export function subscribePersonalCloudBackup(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isPersonalCloudBackupSupported(id: PersonalCloudProviderId): boolean {
  return providers[id].supported();
}

function providerFor(id: PersonalCloudProviderId): PersonalCloudProvider {
  if (!isPersonalCloudBackupSupported(id)) throw new PersonalBackupError("unsupported");
  return providers[id];
}

async function exclusively<T>(work: () => Promise<T>): Promise<T> {
  if (working) throw new PersonalBackupError("busy");
  working = true;
  try {
    return await work();
  } catch (error) {
    if (error instanceof SessionChangedError) throw new PersonalBackupError("sessionChanged");
    throw error;
  } finally {
    working = false;
  }
}

export async function readPersonalCloudBackupStatuses(): Promise<
  Partial<Record<PersonalCloudProviderId, PersonalCloudStatus>>
> {
  const session = await captureCurrentSession();
  const settings = await readSettings(session);
  const result: Partial<Record<PersonalCloudProviderId, PersonalCloudStatus>> = {};
  for (const id of destinations) {
    const value = settings[id];
    if (value) {
      const { connection, savedAt, pending, error, coverage } = value;
      result[id] = { connection, savedAt, pending, error, coverage, running: !!(
        running?.session.bindingVersion === session.bindingVersion &&
        running.session.accountId === session.accountId && running.ids.includes(id)
      ) };
    }
  }
  return result;
}

export async function enablePersonalCloudBackup(
  id: PersonalCloudProviderId,
  expectedAccountId?: string | null,
): Promise<boolean> {
  const enabled = await exclusively(async () => {
    const provider = providerFor(id);
    const session = await captureCurrentSession();
    if (
      !sessionCanUseBackups(session) ||
      (expectedAccountId !== undefined && session.accountId !== expectedAccountId)
    ) throw new PersonalBackupError("sessionChanged");
    const settings = await readSettings(session);
    const connection = await provider.connect();
    if (!connection) {
      if (id === "icloudDrive") throw new PersonalCloudProviderError("reconnect");
      return false;
    }
    const previous = settings[id];
    settings[id] = previous?.connection.id === connection.id
      ? { ...previous, connection, attemptedAt: undefined, error: undefined }
      : { connection };
    try {
      await saveSettings(session, settings);
    } catch (error) {
      if (previous?.connection.id !== connection.id)
        await provider.disconnect?.(connection).catch(() => {});
      throw error;
    }
    if (previous && previous.connection.id !== connection.id)
      await provider.disconnect?.(previous.connection).catch(() => {});
    return true;
  });
  if (enabled) void runPersonalCloudBackupIfDue().catch(() => {});
  return enabled;
}

export function disablePersonalCloudBackup(id: PersonalCloudProviderId): Promise<void> {
  return exclusively(async () => {
    const session = await captureCurrentSession();
    const settings = await readSettings(session);
    const previous = settings[id];
    if (!previous) return;
    delete settings[id];
    await saveSettings(session, settings);
    await providers[id].disconnect?.(previous.connection).catch(() => {});
  });
}

async function requireNetwork(): Promise<void> {
  const state = await getNetworkStateAsync();
  if (state.isConnected === false || state.isInternetReachable === false)
    throw new PersonalCloudProviderError("offline");
}

function elapsed(now: number, then: number | undefined): number {
  return then === undefined || then > now ? Infinity : now - then;
}

function isDue(settings: Settings, now: number, revision: number): boolean {
  if (settings.error === "reconnect") return false;
  if (settings.error && settings.revision === revision && needsNewData(settings.error)) {
    return elapsed(now, settings.attemptedAt) >= MAX_BACKUP_INTERVAL;
  }
  if (settings.error) return elapsed(now, settings.attemptedAt) >= RETRY_INTERVAL;
  const age = elapsed(now, settings.savedAt);
  return age >= MAX_BACKUP_INTERVAL || (settings.revision !== revision && age >= MIN_BACKUP_INTERVAL);
}

function needsNewData(error: BackupError): boolean {
  return error === "empty" || error === "noOwnedVaults" || error === "tooLarge" || error === "unsupported" || error === "invalid";
}

function errorCode(error: unknown): BackupError {
  if (error instanceof SessionChangedError) return "sessionChanged";
  if (error instanceof PersonalBackupError || error instanceof PersonalCloudProviderError)
    return error.code;
  return "providerFailed";
}

async function runBackups(force?: PersonalCloudProviderId): Promise<void> {
  await exclusively(async () => {
    if (force) providerFor(force);
    const session = await captureCurrentSession();
    const settings = await readSettings(session);
    if (force && !settings[force]) throw new PersonalCloudProviderError("reconnect");
    const selected = (force ? [force] : destinations).filter(
      (id) => settings[id] && isPersonalCloudBackupSupported(id),
    );
    if (!selected.length) return;
    const db = await getDb();
    const { install, revision } = await withPersonalBackupSession(session, async () => ({
      install: await getAppMetaInTx(db, "install_id"),
      revision: (await db.getFirstAsync<{ revision: number }>(
        "SELECT COALESCE(MAX(rowid), 0) AS revision FROM event_log",
      ))?.revision ?? 0,
    }));
    if (!install) return;
    const target = { scope: scopeFor(session), device: keyFor(`device:${install}`) };
    const now = Date.now();
    const pending = force ? [] : selected.filter((id) => settings[id]?.pending);

    for (const id of pending) {
      const setting = settings[id]!;
      if (setting.error === "reconnect" || elapsed(now, setting.attemptedAt) < RETRY_INTERVAL) continue;
      try {
        await requireNetwork();
        const files = await providers[id].list(setting.connection, target.scope);
        const copy = files.find((candidate) => candidate.id === setting.copyId);
        setting.pending = copy?.pending === true;
        if (!copy) {
          setting.savedAt = undefined;
          setting.coverage = undefined;
          setting.error = "providerFailed";
        } else {
          setting.error = copy.error;
        }
      } catch (error) {
        setting.error = errorCode(error);
      }
      setting.attemptedAt = now;
      await saveSettings(session, settings);
    }
    const due = selected.filter((id) => force || (
      !settings[id]!.pending && isDue(settings[id]!, now, revision)
    ));
    if (!due.length) return;

    const failures = new Map<PersonalCloudProviderId, unknown>();
    running = { session, ids: due };
    notify();
    try {
      await requireNetwork();
      await withReadablePersonalBackup(session, async (archive, coverage) => {
        for (const id of due) {
          const setting = settings[id]!;
          try {
            await withPersonalBackupSession(session, async () => {});
            const copy = await providers[id].upload(setting.connection, target, archive, now);
            setting.savedAt = copy.createdAt;
            setting.pending = copy.pending === true;
            setting.copyId = copy.id;
            setting.revision = revision;
            setting.coverage = coverage;
            setting.error = copy.error;
          } catch (error) {
            failures.set(id, error);
          }
        }
      });
    } catch (error) {
      for (const id of due) if (!failures.has(id)) failures.set(id, error);
    } finally {
      running = undefined;
      for (const id of due) {
        const setting = settings[id]!;
        setting.attemptedAt = now;
        if (!failures.has(id)) continue;
        setting.error = errorCode(failures.get(id));
        if (needsNewData(setting.error)) setting.revision = revision;
      }
      try {
        await saveSettings(session, settings);
      } catch (error) {
        notify();
        throw error;
      }
    }
    if (force && failures.has(force)) throw failures.get(force);
  });
}

export function runPersonalCloudBackupIfDue(): Promise<void> {
  return working ? Promise.resolve() : runBackups();
}

export function backUpToPersonalCloudNow(id: PersonalCloudProviderId): Promise<void> {
  return runBackups(id);
}

export function findLatestPersonalCloudBackup(id: PersonalCloudProviderId): Promise<
  BackupChoice | null | undefined
> {
  return exclusively(async () => {
    const provider = providerFor(id);
    const session = await captureCurrentSession();
    if (!sessionCanUseBackups(session)) throw new PersonalBackupError("sessionChanged");
    await requireNetwork();
    const settings = await readSettings(session);
    const scope = scopeFor(session);
    let connection = settings[id]?.connection;
    let copies: PersonalCloudCopy[] | undefined;
    if (connection) {
      try {
        copies = await provider.list(connection, scope);
      } catch (error) {
        if (!(error instanceof PersonalCloudProviderError && error.code === "reconnect")) throw error;
      }
    }
    if (!copies) {
      await withPersonalBackupSession(session, async () => {});
      connection = await provider.connect({ temporary: true }) ?? undefined;
      if (!connection) {
        if (id === "icloudDrive") throw new PersonalCloudProviderError("reconnect");
        return undefined;
      }
      await withPersonalBackupSession(session, async () => {});
      copies = await provider.list(connection, scope);
    }
    await withPersonalBackupSession(session, async () => {});
    // A local iCloud copy can be recovered from the device that queued it.
    const copy = copies.sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!copy || !connection) return null;
    const choice = Object.freeze({ name: copy.name, createdAt: copy.createdAt });
    choices.set(choice, { session, id, scope, connection, copy });
    return choice;
  });
}

export function restoreLatestPersonalCloudBackup(choice: BackupChoice): Promise<boolean> {
  return exclusively(async () => {
    const selection = choices.get(choice);
    if (!selection) throw new PersonalBackupError("sessionChanged");
    const { session, id, scope, connection, copy } = selection;
    if (copy.size > DRIVE_BACKUP_FILE_LIMIT) throw new PersonalBackupError("tooLarge");
    await requireNetwork();
    const restored = await restoreDownloadedPersonalBackup(session, (destination) =>
      providerFor(id).download(connection, scope, copy, destination),
    );
    choices.delete(choice);
    return restored;
  });
}
