import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalWebEvent, webBase64ToBytes } from "./web-ledger-protocol.ts";
import type { WebLedger, WebPerson } from "./web-ledger.ts";

test("browser signs device admission and safely retries a lost save response without another person", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  const target = new EventTarget();
  const browser = Object.assign(target, {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  const auth = await import("./web-auth.ts");
  const client = await import("./web-ledger.ts");
  auth.clearWebSession();
  const accountID = crypto.randomUUID();
  const vaultID = crypto.randomUUID();
  let installID = "";
  let publicKey = "";
  let losePersonResponse = true;
  let personPushCount = 0;
  const events = new Set<string>();
  const ledger: WebLedger = {
    vault_id: vaultID,
    name: "Test",
    role: "owner",
    currency: "AFN",
    legacy_currency: "AFN",
    default_entry_currency: "AFN",
    enabled_currencies: ["AFN", "USD"],
    archived_at_ms: null,
    server_seq: 0,
    hlc_last: { pms: Date.now() - 1000, l: 0, did: crypto.randomUUID() },
    device_registered: false,
    device_pubkey: null,
    people: [],
    entries: [],
    incomplete_people: 0,
  };
  const respond = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/auth/google") {
      installID = body.install_id;
      const jwt = `header.${btoa(JSON.stringify({ account_id: accountID, install_id: installID, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
      return respond({
        session_jwt: jwt,
        account_id: accountID,
        default_vault_id: vaultID,
        user: { name: "Owner", has_password: true },
      });
    }
    if (path === "/v1/sync/ledger") return respond(ledger);
    if (path === "/v1/devices/register-key") {
      publicKey = body.ed25519_pubkey;
      return respond({ registered: true });
    }
    if (path === "/v1/vaults" && init?.method === "POST")
      return new Response(JSON.stringify({ error: "Kaata creation refused" }), { status: 403 });
    if (path === `/v1/vaults/${vaultID}/witness`)
      return respond({
        server_key_id: "primary",
        device_witness: { sig_b64: "witness", issued_at_ms: Date.now() },
      });
    if (path === "/v1/sync/push") {
      assert.equal(body.device_id, installID);
      assert.equal(body.vault_id, vaultID);
      assert.equal(new Headers(init?.headers).get("X-Kaata-Currencies"), "1");
      assert.equal(new Headers(init?.headers).get("X-Kaata-Tab-Group"), "1");
      const accepted: { event_id: string; server_seq: number }[] = [];
      const duplicates: string[] = [];
      for (const event of body.events) {
        const key = await crypto.subtle.importKey(
          "raw",
          webBase64ToBytes(publicKey),
          "Ed25519",
          false,
          ["verify"],
        );
        const canonical = canonicalWebEvent({
          event_id: event.event_id,
          event_type: event.event_type,
          vault_id: vaultID,
          target_id: event.target_id,
          relationship_id: event.relationship_id,
          hlc: { pms: event.hlc.physical_ms, l: event.hlc.logical, did: event.hlc.device_id },
          device_id: installID,
          actor_account_id: accountID,
          payload_schema: event.schema_version,
          payload: event.payload,
        });
        assert.equal(
          await crypto.subtle.verify(
            "Ed25519",
            key,
            webBase64ToBytes(event.event_sig_b64),
            canonical as Uint8Array<ArrayBuffer>,
          ),
          true,
        );
        if (event.event_type === "person_added") personPushCount++;
        if (events.has(event.event_id)) {
          duplicates.push(event.event_id);
          continue;
        }
        events.add(event.event_id);
        ledger.hlc_last = {
          pms: event.hlc.physical_ms,
          l: event.hlc.logical,
          did: event.hlc.device_id,
        };
        ledger.server_seq++;
        if (event.event_type === "vault_device_added") {
          assert.equal(event.payload.device_pubkey, publicKey);
          assert.equal(event.payload.account_id, accountID);
          assert.equal(event.payload.witness.sig_b64, "witness");
          ledger.device_registered = true;
          ledger.device_pubkey = publicKey;
        }
        if (event.event_type === "person_added")
          ledger.people.push({
            relationship_id: event.relationship_id,
            user_id: event.target_id,
            name: event.payload.name,
            phone_e164: event.payload.phone_e164,
            default_entry_currency: null,
            archived_at: null,
            read_only: false,
            read_only_reason: null,
          });
        if (event.event_type === "entry_created")
          ledger.entries.push({
            id: event.target_id,
            relationship_id: event.relationship_id,
            type: event.payload.type,
            amount_afn: String(event.payload.amount_afn),
            currency: event.payload.currency,
            note: event.payload.note,
            created_at: event.payload.occurred_at_ms,
            recorded_at_ms: event.payload.recorded_at_ms,
            updated_at: event.hlc.physical_ms,
            current_event_id: event.event_id,
            is_deleted: false,
            read_only: false,
            settled_at: null,
          });
        if (event.event_type === "entry_amended") {
          const row = ledger.entries.find((entry) => entry.id === event.target_id)!;
          const changes = event.payload.changes;
          if (changes.amount_afn !== undefined) row.amount_afn = String(changes.amount_afn);
          if (changes.currency !== undefined) row.currency = changes.currency;
          if (changes.type !== undefined) row.type = changes.type;
          if (changes.note !== undefined) row.note = changes.note;
          if (changes.occurred_at_ms !== undefined) row.created_at = changes.occurred_at_ms;
          row.current_event_id = event.event_id;
          row.updated_at = event.hlc.physical_ms;
        }
        accepted.push({ event_id: event.event_id, server_seq: ledger.server_seq });
      }
      if (
        body.events.some((event: { event_type: string }) => event.event_type === "person_added") &&
        losePersonResponse
      ) {
        losePersonResponse = false;
        throw new TypeError("connection lost after commit");
      }
      return respond({ accepted, duplicates, rejected: [] });
    }
    if (path === "/v1/auth/signout") return respond({ signed_out: true });
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    await auth.signInWithGoogle("fixture-google-token", auth.createWebAuthNonce());
    const initial = structuredClone(ledger);
    const personInput = { name: "Ahmad", phone_e164: "+93701234567" };
    await assert.rejects(client.createWebPerson(initial, personInput), /Cannot reach/);
    assert.equal(client.hasPendingWebWrite(), true);
    assert.equal(ledger.people.length, 1);
    await assert.rejects(client.createWebPerson(initial, { name: "Different" }), /previous save/);
    const relationshipID = await client.createWebPerson(initial, personInput);
    assert.equal(relationshipID, ledger.people[0].relationship_id);
    assert.equal(personPushCount, 2);
    assert.equal(ledger.people.length, 1);
    assert.equal(client.hasPendingWebWrite(), false);

    await client.createWebEntry(ledger, ledger.people[0], {
      type: "debt",
      amount: "۱۲٫۵۰",
      currency: "USD",
      note: "دکان",
      occurred_at_ms: Date.now() - 100,
    });
    assert.equal(ledger.entries[0].amount_afn, "12.5");
    assert.equal(ledger.entries[0].currency, "USD");
    const stale = { ...ledger.entries[0], current_event_id: crypto.randomUUID() };
    await assert.rejects(client.deleteWebEntry(ledger, stale), /Someone changed/);
    const settled = ledger.entries[0];
    settled.read_only = true;
    settled.settled_at = Date.now();
    await assert.rejects(client.deleteWebEntry(ledger, settled), /no longer/);

    // A remotely settled frontier can be ahead of this browser's clock.
    // Business dates remain editable; immutable recording time keeps the
    // backdated new pair in the open chapter instead of stranding a zero.
    const boundary = Date.now() + 60_000;
    ledger.people[0].settled_through = { AFN: boundary };
    const backdatedInput = {
      type: "debt" as const,
      amount: "2660",
      currency: "AFN",
      note: null,
      occurred_at_ms: boundary - 5 * 86_400_000,
    };
    await client.createWebEntry(ledger, ledger.people[0], backdatedInput);
    const backdated = ledger.entries.at(-1)!;
    assert.equal(backdated.created_at, backdatedInput.occurred_at_ms);
    assert.equal(
      backdated.recorded_at_ms,
      boundary + 1,
      "recording advances beyond the settled frontier",
    );
    await client.createWebEntry(ledger, ledger.people[0], {
      ...backdatedInput,
      type: "payment",
      occurred_at_ms: Date.now(),
    });
    assert.equal(ledger.entries.at(-1)!.recorded_at_ms, boundary + 1);
    assert.equal(
      ledger.entries
        .filter((entry) => entry.currency === "AFN")
        .reduce(
          (total, entry) => total + (entry.type === "debt" ? 1 : -1) * Number(entry.amount_afn),
          0,
        ),
      0,
    );
    await client.updateWebEntry(ledger, backdated, {
      ...backdatedInput,
      note: "Earlier business day",
      occurred_at_ms: boundary - 10 * 86_400_000,
    });
    assert.equal(backdated.created_at, boundary - 10 * 86_400_000);
    assert.equal(
      backdated.recorded_at_ms,
      boundary + 1,
      "date edits never move chapter membership",
    );
    ledger.people[0].settled_through.USD = boundary + 100;
    const beforeCurrencyMove = events.size;
    await assert.rejects(
      client.updateWebEntry(ledger, backdated, { ...backdatedInput, currency: "USD" }),
      {
        code: "entry_read_only",
      },
    );
    assert.equal(
      events.size,
      beforeCurrencyMove,
      "a currency change cannot enter that currency's closed history",
    );
    ledger.people[0].settled_through.AFN = boundary + 1;
    backdated.read_only = true;
    backdated.settled_at = boundary + 1;
    await assert.rejects(
      client.updateWebEntry(ledger, backdated, {
        ...backdatedInput,
        occurred_at_ms: boundary + 1000,
      }),
      { code: "entry_read_only" },
    );

    const linked: WebPerson = {
      ...ledger.people[0],
      read_only: true,
      read_only_reason: "shared_tab",
    };
    ledger.people[0] = linked;
    await assert.rejects(
      client.createWebEntry(ledger, linked, {
        type: "payment",
        amount: "2",
        currency: "AFN",
        note: null,
        occurred_at_ms: Date.now(),
      }),
      /mobile app/,
    );
    ledger.role = "viewer";
    await assert.rejects(client.createWebPerson(ledger, { name: "Blocked" }), /permission/);
    ledger.role = "owner";
    ledger.device_pubkey = "different-key";
    await assert.rejects(client.createWebPerson(ledger, { name: "Wrong device key" }), {
      code: "signing_key_missing",
    });
    ledger.device_pubkey = publicKey;
    await assert.rejects(client.createWebVault({ name: "Refused kaata", currency: "AFN" }), {
      status: 403,
    });
    assert.equal(client.hasPendingWebWrite(), false);
    assert.equal(storage.has("kaata_web_pending_v1"), false);
    assert.ok(storage.has("kaata_web_signing_v1"));
    const realNow = Date.now;
    const expiredTime = realNow() + 2 * 60 * 60 * 1000;
    try {
      Date.now = () => expiredTime;
      await assert.rejects(client.getWebLedger(vaultID), { code: "session_expired" });
      assert.equal(auth.getWebSession(), null);
    } finally {
      Date.now = realNow;
    }
    assert.equal(storage.has("kaata_web_signing_v1"), false);
    assert.equal(storage.has("kaata_web_pending_v1"), false);
    assert.equal(client.hasPendingWebWrite(), false);
  } finally {
    auth.clearWebSession();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
