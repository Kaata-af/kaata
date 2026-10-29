import {
  getWebSession,
  clearWebSession,
  webRequest,
  WebApiError,
  WEB_SESSION_EVENT,
  type WebSession,
} from "./web-auth";
import {
  bytesToWebBase64,
  canonicalWebEvent,
  canonicalWebJSON,
  nextWebHLC,
  normalizeWebPhone,
  parseWebEntryAmount,
  webBase64ToBytes,
  WebLedgerError,
  type SignableWebEvent,
  type WebHLC,
} from "./web-ledger-protocol";

export {
  normalizeWebPhone,
  parseWebEntryAmount,
  webAmountMinor,
  WebLedgerError,
} from "./web-ledger-protocol";
export type WebRole = "owner" | "manager" | "editor" | "clerk" | "viewer";
export type WebVault = {
  vault_id: string;
  name: string;
  role: WebRole;
  currency: string;
  legacy_currency: string;
  default_entry_currency: string;
  archived_at_ms?: number | null;
  members_count: number;
};
export type WebPerson = {
  relationship_id: string;
  user_id: string;
  name: string;
  phone_e164: string | null;
  // Optional while the web and backend deployments roll out independently.
  created_at?: number;
  last_entry_at?: number | null;
  is_settled?: boolean | null;
  default_entry_currency: string | null;
  archived_at: number | null;
  read_only: boolean;
  read_only_reason: "shared_tab" | "archived" | null;
  settled_through?: Record<string, number>;
};
export type WebEntry = {
  id: string;
  relationship_id: string;
  type: "debt" | "payment";
  amount_afn: string;
  currency: string;
  note: string | null;
  created_at: number;
  recorded_at_ms?: number;
  updated_at: number;
  current_event_id: string;
  is_deleted: boolean;
  read_only: boolean;
  settled_at: number | null;
};
export type WebLedger = {
  vault_id: string;
  name: string;
  role: WebRole;
  currency: string;
  legacy_currency: string;
  default_entry_currency: string;
  enabled_currencies: string[];
  archived_at_ms: number | null;
  server_seq: number;
  hlc_last: WebHLC;
  device_registered: boolean;
  device_pubkey?: string | null;
  people: WebPerson[];
  entries: WebEntry[];
  incomplete_people: number;
};
export type WebEntryInput = {
  type: "debt" | "payment";
  amount: string;
  currency: string;
  note: string | null;
  occurred_at_ms: number;
};
type EventDraft = { type: string; target: string; relationship?: string; payload: unknown };
type SignedPushEvent = {
  event_id: string;
  event_type: string;
  schema_version: number;
  target_id: string;
  relationship_id: string | null;
  actor_account_id: string;
  hlc: { physical_ms: number; logical: number; device_id: string };
  payload: unknown;
  event_sig_b64: string;
  signer_device_pubkey: string;
};
type PushResult = {
  accepted: { event_id: string; server_seq: number }[];
  duplicates: string[];
  rejected: { event_id: string; reason: string }[];
};
type Identity = { installID: string; publicKey: string; privateKey: CryptoKey };
type PendingWrite = {
  installID: string;
  accountID: string;
  vaultID: string;
  fingerprint: string;
  events: SignedPushEvent[];
  result: string;
  create?: {
    vault_id: string;
    name: string;
    currency: string;
    created_at_ms: number;
    vault_trust_anchor_pubkey: string;
  };
};
const IDENTITY_KEY = "kaata_web_signing_v1";
const PENDING_KEY = "kaata_web_pending_v1";
const HEADERS = {
  "X-Kaata-Currencies": "1",
  "X-Kaata-Entry-Currency-Edit": "1",
  "X-Kaata-Tab-Group": "1",
};
let identityPromise: Promise<Identity> | undefined;
let identityInstallID: string | undefined;
let inFlight: Promise<unknown> = Promise.resolve();

function currentSession(): WebSession {
  const session = getWebSession();
  if (!session) {
    // Local expiry occurs before HTTP. Notify the UI and erase tab-scoped
    // signing material just as an authenticated 401 would.
    clearWebSession();
    throw new WebLedgerError("Your session has ended. Sign in again.", "session_expired");
  }
  return session;
}

function assertSession(session: WebSession): void {
  if (getWebSession()?.session_jwt !== session.session_jwt)
    throw new WebLedgerError("Your account changed. Open the kaata again.", "session_expired");
}

function sessionJSON<T>(key: string): T | null {
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    throw new WebLedgerError(
      "Browser storage is unavailable. Enable it before saving.",
      "secure_storage",
    );
  }
}

function storePending(value: PendingWrite): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    throw new WebLedgerError(
      "Browser storage is unavailable. Enable it before saving.",
      "secure_storage",
    );
  }
}

// The JWT and signing material share a tab-scoped lifetime. Nothing is placed
// in localStorage. A fresh login always has a fresh install/device identity.
function clearOldIdentity(): void {
  const installID = getWebSession()?.install_id;
  if (identityInstallID !== installID) {
    identityPromise = undefined;
    identityInstallID = installID;
  }
  try {
    for (const key of [IDENTITY_KEY, PENDING_KEY]) {
      const value = sessionJSON<{ installID: string }>(key);
      if (value && value.installID !== installID) window.sessionStorage.removeItem(key);
    }
  } catch {
    /* A later write refuses unavailable or damaged storage. */
  }
}
if (typeof window !== "undefined") {
  window.addEventListener(WEB_SESSION_EVENT, clearOldIdentity);
  clearOldIdentity();
}

export function getWebWriteSupport(): boolean {
  return (
    typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.randomUUID === "function"
  );
}

async function getIdentity(session: WebSession, mustExist = false): Promise<Identity> {
  if (identityInstallID !== session.install_id) {
    identityPromise = undefined;
    identityInstallID = session.install_id;
  }
  if (!identityPromise) {
    identityPromise = (async () => {
      if (!getWebWriteSupport())
        throw new WebLedgerError(
          "Use an updated browser over HTTPS to save changes.",
          "secure_storage",
        );
      let stored = sessionJSON<{ installID: string; publicKey: string; privateKey: string }>(
        IDENTITY_KEY,
      );
      if (stored?.installID !== session.install_id) stored = null;
      if (mustExist && !stored)
        throw new WebLedgerError(
          "This browser's signing key is missing. Sign out and sign in again before saving.",
          "signing_key_missing",
        );
      try {
        if (!stored) {
          const pair = (await crypto.subtle.generateKey("Ed25519", true, [
            "sign",
            "verify",
          ])) as CryptoKeyPair;
          stored = {
            installID: session.install_id,
            publicKey: bytesToWebBase64(
              new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
            ),
            privateKey: bytesToWebBase64(
              new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
            ),
          };
          assertSession(session);
          window.sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(stored));
        }
        const privateKey = await crypto.subtle.importKey(
          "pkcs8",
          webBase64ToBytes(stored.privateKey),
          "Ed25519",
          false,
          ["sign"],
        );
        const publicKey = await crypto.subtle.importKey(
          "raw",
          webBase64ToBytes(stored.publicKey),
          "Ed25519",
          false,
          ["verify"],
        );
        const probe = new TextEncoder().encode("kaata-web-device");
        const signed = await crypto.subtle.sign("Ed25519", privateKey, probe);
        if (!(await crypto.subtle.verify("Ed25519", publicKey, signed, probe)))
          throw new Error("key mismatch");
        assertSession(session);
        return { installID: session.install_id, publicKey: stored.publicKey, privateKey };
      } catch {
        throw new WebLedgerError(
          "This browser could not prepare secure saving. Enable browser storage and use an updated Chrome, Edge, Firefox, or Safari.",
          "secure_storage",
        );
      }
    })().catch((error) => {
      identityPromise = undefined;
      throw error;
    });
  }
  return identityPromise;
}

export async function listWebVaults(): Promise<WebVault[]> {
  const session = currentSession();
  const result = await webRequest<{ vaults: WebVault[] }>("/v1/vaults", { headers: HEADERS });
  assertSession(session);
  return result.vaults;
}

export async function getWebLedger(vaultID: string): Promise<WebLedger> {
  const session = currentSession();
  const ledger = await webRequest<WebLedger>(
    `/v1/sync/ledger?vault_id=${encodeURIComponent(vaultID)}`,
    {
      headers: HEADERS,
    },
  );
  assertSession(session);
  return ledger;
}

async function signDrafts(
  session: WebSession,
  identity: Identity,
  vaultID: string,
  frontier: WebHLC,
  drafts: EventDraft[],
): Promise<SignedPushEvent[]> {
  const events: SignedPushEvent[] = [];
  let hlc = frontier;
  for (const draft of drafts) {
    hlc = nextWebHLC(hlc, session.install_id);
    const event: SignableWebEvent = {
      event_id: crypto.randomUUID(),
      event_type: draft.type,
      vault_id: vaultID,
      target_id: draft.target,
      relationship_id: draft.relationship ?? null,
      hlc,
      device_id: session.install_id,
      actor_account_id: session.account_id,
      payload_schema: 1,
      payload: draft.payload,
    };
    const signature = await crypto.subtle.sign(
      "Ed25519",
      identity.privateKey,
      canonicalWebEvent(event) as Uint8Array<ArrayBuffer>,
    );
    events.push({
      event_id: event.event_id,
      event_type: event.event_type,
      schema_version: 1,
      target_id: event.target_id,
      relationship_id: event.relationship_id,
      actor_account_id: session.account_id,
      hlc: { physical_ms: hlc.pms, logical: hlc.l, device_id: hlc.did },
      payload: draft.payload,
      event_sig_b64: bytesToWebBase64(new Uint8Array(signature)),
      signer_device_pubkey: identity.publicKey,
    });
  }
  assertSession(session);
  return events;
}

async function pushEvents(
  session: WebSession,
  vaultID: string,
  events: SignedPushEvent[],
): Promise<void> {
  assertSession(session);
  const result = await webRequest<PushResult>("/v1/sync/push", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ vault_id: vaultID, device_id: session.install_id, events }),
  });
  assertSession(session);
  if (result.rejected.length) {
    const reason = result.rejected[0].reason;
    throw new WebLedgerRejection(
      reason === "credit_limit_exceeded"
        ? "This entry exceeds the credit limit set for this person."
        : reason === "insufficient_role"
          ? "Your access changed. Refresh this kaata before saving."
          : "Kaata refused this change. Refresh the ledger and try again.",
      reason,
    );
  }
  const accepted = new Set([
    ...result.accepted.map((event) => event.event_id),
    ...result.duplicates,
  ]);
  if (events.some((event) => !accepted.has(event.event_id)))
    throw new WebLedgerError(
      "Saving could not be confirmed. Try the same action again.",
      "pending_write",
    );
}

export class WebLedgerRejection extends WebLedgerError {
  constructor(
    message: string,
    public reason: string,
  ) {
    super(message, reason);
  }
}

async function admitDevice(
  session: WebSession,
  identity: Identity,
  ledger: WebLedger,
): Promise<WebLedger> {
  if (ledger.device_registered) {
    if (ledger.device_pubkey && ledger.device_pubkey !== identity.publicKey)
      throw new WebLedgerError(
        "This browser's signing key changed. Sign out and sign in again.",
        "signing_key_missing",
      );
    return ledger;
  }
  assertSession(session);
  await webRequest("/v1/devices/register-key", {
    method: "POST",
    body: JSON.stringify({ ed25519_pubkey: identity.publicKey }),
  });
  assertSession(session);
  const witness = await webRequest<{
    server_key_id: string;
    device_witness: { sig_b64: string; issued_at_ms: number };
  }>(`/v1/vaults/${encodeURIComponent(ledger.vault_id)}/witness`, { method: "POST" });
  assertSession(session);
  const events = await signDrafts(session, identity, ledger.vault_id, ledger.hlc_last, [
    {
      type: "vault_device_added",
      target: session.install_id,
      payload: {
        account_id: session.account_id,
        device_id: session.install_id,
        device_pubkey: identity.publicKey,
        witness: { ...witness.device_witness, server_key_id: witness.server_key_id },
      },
    },
  ]);
  await pushEvents(session, ledger.vault_id, events);
  const fresh = await getWebLedger(ledger.vault_id);
  assertSession(session);
  if (!fresh.device_registered)
    throw new WebLedgerError(
      "This browser is not yet authorized to save. Try again.",
      "device_unverified",
    );
  return fresh;
}

function assertCanWrite(ledger: WebLedger, amend = false): void {
  const allowed = amend ? ["owner", "manager", "editor"] : ["owner", "manager", "editor", "clerk"];
  if (ledger.archived_at_ms != null || !allowed.includes(ledger.role)) {
    throw new WebLedgerError(
      "You do not have permission to make this change.",
      "permission_denied",
    );
  }
}

function writablePerson(ledger: WebLedger, relationshipID: string): WebPerson {
  const person = ledger.people.find((item) => item.relationship_id === relationshipID);
  if (!person || person.read_only || person.archived_at != null)
    throw new WebLedgerError(
      "Open this person's account in the mobile app to make changes.",
      "person_read_only",
    );
  return person;
}

function writableEntry(ledger: WebLedger, original: WebEntry): WebEntry {
  const entry = ledger.entries.find((item) => item.id === original.id);
  if (!entry || entry.is_deleted || entry.read_only || entry.settled_at != null)
    throw new WebLedgerError("This entry can no longer be changed.", "entry_read_only");
  writablePerson(ledger, entry.relationship_id);
  if (entry.current_event_id !== original.current_event_id)
    throw new WebLedgerError(
      "Someone changed this entry. Refresh and review it before saving.",
      "stale_entry",
    );
  return entry;
}

function validatePersonInput(
  ledger: WebLedger,
  name: string,
  phone: string | null | undefined,
  exceptID?: string,
) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120)
    throw new WebLedgerError("Enter a name of up to 120 characters.", "invalid_name");
  const normalized = normalizeWebPhone(phone);
  if (normalized && normalized === currentSession().user.phone)
    throw new WebLedgerError("Use the other person's phone number, not your own.", "self_phone");
  if (
    normalized &&
    ledger.people.some(
      (person) =>
        person.relationship_id !== exceptID &&
        person.archived_at == null &&
        person.phone_e164 === normalized,
    )
  ) {
    throw new WebLedgerError(
      "This phone number already belongs to someone in this kaata.",
      "duplicate_phone",
    );
  }
  return { name: trimmed, phone_e164: normalized };
}

function entryPayload(input: WebEntryInput, allowedCurrencies: string[]) {
  if (input.type !== "debt" && input.type !== "payment")
    throw new WebLedgerError("Choose gave or received.", "invalid_entry_type");
  if (!/^[A-Z]{3}$/.test(input.currency) || !allowedCurrencies.includes(input.currency))
    throw new WebLedgerError("Choose one of this kaata's currencies.", "invalid_currency");
  if (
    !Number.isSafeInteger(input.occurred_at_ms) ||
    input.occurred_at_ms <= 0 ||
    input.occurred_at_ms > Date.now() + 86_400_000
  )
    throw new WebLedgerError("Choose a valid entry date.", "invalid_date");
  const note = input.note?.trim() || null;
  if (note && note.length > 500)
    throw new WebLedgerError("Keep the note under 500 characters.", "invalid_note");
  return {
    type: input.type,
    amount_afn: parseWebEntryAmount(input.amount),
    currency: input.currency,
    note,
    occurred_at_ms: input.occurred_at_ms,
  };
}

async function replayPending(session: WebSession, pending: PendingWrite): Promise<string> {
  assertSession(session);
  if (pending.installID !== session.install_id || pending.accountID !== session.account_id)
    throw new WebLedgerError("Your account changed. Sign in again.", "session_expired");
  try {
    if (pending.create) {
      await webRequest("/v1/vaults", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(pending.create),
      });
      assertSession(session);
    }
    await pushEvents(session, pending.vaultID, pending.events);
  } catch (error) {
    // Explicit rejection is final for this batch. Network failures leave the
    // exact signed IDs available for safe retry instead of minting duplicates.
    if (
      error instanceof WebLedgerRejection ||
      (error instanceof WebApiError && [400, 403, 404, 413, 426].includes(error.status))
    ) {
      window.sessionStorage.removeItem(PENDING_KEY);
    }
    throw error;
  }
  window.sessionStorage.removeItem(PENDING_KEY);
  return pending.result;
}

export function hasPendingWebWrite(): boolean {
  try {
    const session = getWebSession();
    return !!session && sessionJSON<PendingWrite>(PENDING_KEY)?.installID === session.install_id;
  } catch {
    return false;
  }
}

async function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request(
        `kaata-write:${currentSession().install_id}`,
        async () => await task(),
      );
    }
    return await task();
  };
  const result = inFlight.then(run, run);
  inFlight = result.catch(() => {});
  return result;
}

export function retryPendingWebWrite(): Promise<string | null> {
  const session = currentSession();
  return serialized(async () => {
    assertSession(session);
    const pending = sessionJSON<PendingWrite>(PENDING_KEY);
    if (!pending) return null;
    await replayPending(session, pending);
    return pending.vaultID;
  });
}

async function write(
  ledger: WebLedger,
  operation: unknown,
  amend: boolean,
  build: (fresh: WebLedger) => { drafts: EventDraft[]; result: string },
): Promise<string> {
  const session = currentSession();
  return serialized(async () => {
    assertSession(session);
    const fingerprint = canonicalWebJSON({ vault: ledger.vault_id, operation });
    const pending = sessionJSON<PendingWrite>(PENDING_KEY);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new WebLedgerError(
          "A previous save still needs confirmation. Retry that save before making another change.",
          "pending_write",
        );
      return replayPending(session, pending);
    }
    let fresh = await getWebLedger(ledger.vault_id);
    assertSession(session);
    assertCanWrite(fresh, amend);
    const identity = await getIdentity(session, fresh.device_registered);
    fresh = await admitDevice(session, identity, fresh);
    assertCanWrite(fresh, amend);
    const { drafts, result } = build(fresh);
    if (!drafts.length) return result;
    const events = await signDrafts(session, identity, fresh.vault_id, fresh.hlc_last, drafts);
    const item: PendingWrite = {
      installID: session.install_id,
      accountID: session.account_id,
      vaultID: fresh.vault_id,
      fingerprint,
      events,
      result,
    };
    // Required before HTTP: storage failure must not risk an unrepeatable save.
    storePending(item);
    return replayPending(session, item);
  });
}

export function createWebPerson(
  ledger: WebLedger,
  input: { name: string; phone_e164?: string | null },
): Promise<string> {
  return write(ledger, { action: "person-create", ...input }, false, (fresh) => {
    const person = validatePersonInput(fresh, input.name, input.phone_e164);
    const userID = crypto.randomUUID();
    const relationshipID = crypto.randomUUID();
    return {
      result: relationshipID,
      drafts: [
        {
          type: "person_added",
          target: userID,
          relationship: relationshipID,
          payload: { user_id: userID, ...person, relationship_context: "peer" },
        },
      ],
    };
  });
}

export async function updateWebPerson(
  ledger: WebLedger,
  original: WebPerson,
  input: { name: string; phone_e164?: string | null },
): Promise<void> {
  await write(
    ledger,
    { action: "person-edit", relationship: original.relationship_id, ...input },
    true,
    (fresh) => {
      const person = writablePerson(fresh, original.relationship_id);
      if (person.name !== original.name || person.phone_e164 !== original.phone_e164)
        throw new WebLedgerError(
          "Someone changed this person. Refresh before saving.",
          "stale_person",
        );
      const values = validatePersonInput(
        fresh,
        input.name,
        input.phone_e164,
        person.relationship_id,
      );
      const drafts: EventDraft[] = [];
      if (values.name !== person.name)
        drafts.push({
          type: "person_renamed",
          target: person.user_id,
          relationship: person.relationship_id,
          payload: { name: values.name },
        });
      if (values.phone_e164 !== person.phone_e164)
        drafts.push({
          type: "person_phone_changed",
          target: person.user_id,
          relationship: person.relationship_id,
          payload: { phone_e164: values.phone_e164 },
        });
      return { result: person.relationship_id, drafts };
    },
  );
}

export async function createWebEntry(
  ledger: WebLedger,
  person: WebPerson,
  input: WebEntryInput,
): Promise<void> {
  await write(
    ledger,
    { action: "entry-create", relationship: person.relationship_id, ...input },
    false,
    (fresh) => {
      const current = writablePerson(fresh, person.relationship_id);
      // Settlement chapters follow recording order. A backdated business day
      // must not place this newly authored tally inside immutable history.
      const recordedAt = Math.max(Date.now(), (current.settled_through?.[input.currency] ?? 0) + 1);
      const id = crypto.randomUUID();
      return {
        result: id,
        drafts: [
          {
            type: "entry_created",
            target: id,
            relationship: person.relationship_id,
            payload: {
              ...entryPayload(input, fresh.enabled_currencies),
              entry_id: id,
              relationship_id: person.relationship_id,
              recorded_at_ms: recordedAt,
            },
          },
        ],
      };
    },
  );
}

export async function updateWebEntry(
  ledger: WebLedger,
  original: WebEntry,
  input: WebEntryInput,
): Promise<void> {
  await write(ledger, { action: "entry-edit", id: original.id, ...input }, true, (fresh) => {
    const entry = writableEntry(fresh, original);
    const person = writablePerson(fresh, entry.relationship_id);
    const recordedAt = entry.recorded_at_ms ?? entry.created_at;
    if (
      input.currency !== entry.currency &&
      recordedAt <= (person.settled_through?.[input.currency] ?? 0)
    )
      throw new WebLedgerError(
        "This currency's settled history cannot be changed.",
        "entry_read_only",
      );
    const values = entryPayload(input, [...fresh.enabled_currencies, entry.currency]);
    // Delta-only amendments preserve concurrent changes to untouched fields.
    const changes: Record<string, unknown> = {};
    if (values.amount_afn !== Number(entry.amount_afn) || values.currency !== entry.currency) {
      changes.amount_afn = values.amount_afn;
      changes.currency = values.currency;
    }
    if (values.type !== entry.type) changes.type = values.type;
    if (values.note !== entry.note) changes.note = values.note;
    if (values.occurred_at_ms !== entry.created_at) changes.occurred_at_ms = values.occurred_at_ms;
    return {
      result: entry.id,
      drafts: Object.keys(changes).length
        ? [
            {
              type: "entry_amended",
              target: entry.id,
              relationship: entry.relationship_id,
              payload: { changes },
            },
          ]
        : [],
    };
  });
}

export async function deleteWebEntry(ledger: WebLedger, original: WebEntry): Promise<void> {
  await write(
    ledger,
    { action: "entry-delete", id: original.id, revision: original.current_event_id },
    true,
    (fresh) => {
      const entry = writableEntry(fresh, original);
      return {
        result: entry.id,
        drafts: [
          {
            type: "entry_deleted",
            target: entry.id,
            relationship: entry.relationship_id,
            payload: {},
          },
        ],
      };
    },
  );
}

export function createWebVault(input: { name: string; currency: string }): Promise<string> {
  const session = currentSession();
  return serialized(async () => {
    assertSession(session);
    const name = input.name.trim();
    if (!name || name.length > 120 || !/^[A-Z]{3}$/.test(input.currency))
      throw new WebLedgerError("Enter a kaata name and currency.", "invalid_vault");
    const fingerprint = canonicalWebJSON({
      action: "vault-create",
      name,
      currency: input.currency,
    });
    const pending = sessionJSON<PendingWrite>(PENDING_KEY);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new WebLedgerError(
          "Confirm the previous save before creating a kaata.",
          "pending_write",
        );
      return replayPending(session, pending);
    }
    const identity = await getIdentity(session);
    await webRequest("/v1/devices/register-key", {
      method: "POST",
      body: JSON.stringify({ ed25519_pubkey: identity.publicKey }),
    });
    assertSession(session);
    const vaultID = crypto.randomUUID();
    const events = await signDrafts(
      session,
      identity,
      vaultID,
      { pms: 0, l: 0, did: session.install_id },
      [
        {
          type: "vault_member_added",
          target: session.account_id,
          payload: { account_id: session.account_id, role: "owner" },
        },
        {
          type: "vault_device_added",
          target: session.install_id,
          payload: {
            account_id: session.account_id,
            device_id: session.install_id,
            device_pubkey: identity.publicKey,
          },
        },
        {
          type: "shop_profile_updated",
          target: vaultID,
          payload: { changes: { shop_name: name, owner_name: session.user.name || null } },
        },
        {
          type: "vault_setting_set",
          target: vaultID,
          payload: { key: "default_entry_currency", value: input.currency },
        },
        {
          type: "vault_setting_set",
          target: vaultID,
          payload: { key: "enabled_currencies", value: JSON.stringify([input.currency]) },
        },
      ],
    );
    const item: PendingWrite = {
      installID: session.install_id,
      accountID: session.account_id,
      vaultID,
      fingerprint,
      events,
      result: vaultID,
      create: {
        vault_id: vaultID,
        name,
        currency: input.currency,
        created_at_ms: Date.now(),
        vault_trust_anchor_pubkey: identity.publicKey,
      },
    };
    storePending(item);
    return replayPending(session, item);
  });
}
