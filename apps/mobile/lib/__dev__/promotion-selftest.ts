// Executes proposal persistence, HTTP receipt validation and the real screen
// with synthetic storage/network boundaries. No device data or service calls.
import assert from "node:assert/strict";
import { CURRENCIES } from "../currency-catalog";
import type { ProposalFields, ProposalSubmission } from "../promotion-proposals";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

class Clock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, run });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };
  async advance(delay: number, settle: () => Promise<void> = settleUI) {
    const target = this.now + delay;
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].run();
      await settle();
    }
    this.now = target;
  }
}

const validFields: ProposalFields = {
  business_name: "Synthetic Flour Shop",
  contact_name: "Synthetic owner",
  phone: "0700 123 456",
  proposal: "We propose a product promotion for shopkeepers.",
  budget_amount: "1500.50",
  budget_currency: "AFN",
  duration: "Two weeks",
};

function environment(locale: "en" | "fa" | "ps" = "en") {
  const storage = new Map<string, string>();
  const requests: ProposalSubmission[] = [];
  const writes: { key: string; value: string }[] = [];
  const clock = new Clock();
  let uuidCount = 0;
  let failWrite = false;
  let fetchReply: (
    submission: ProposalSubmission,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> = async (
    submission,
  ) => ({
    ok: true,
    status: 201,
    json: async () => ({
      id: 37,
      submission_id: submission.submission_id,
      created_at: "2026-11-05T08:00:00Z",
    }),
  });
  const db = {
    getAppMeta: async (key: string) => storage.get(key) ?? null,
    setAppMeta: async (key: string, value: string) => {
      writes.push({ key, value });
      if (failWrite) throw new Error("Synthetic storage failure");
      storage.set(key, value);
    },
  };
  const language = compileUI("../i18n", {
    "expo-localization": { getLocales: () => [{ languageCode: locale }] },
    "./db": db,
  }) as typeof import("../i18n");
  language.setLocale(locale);
  const phone = compileUI("../phone", {
    "./db": db,
    "./digits": require("../digits"),
    "./phone-countries": require("../phone-countries"),
    "libphonenumber-js/core": require("libphonenumber-js/core"),
    "libphonenumber-js/metadata.min.json": require("libphonenumber-js/metadata.min.json"),
  }) as typeof import("../phone");
  const model = compileUI(
    "../promotion-proposals",
    {
      "expo-crypto": {
        randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, "0")}`,
      },
      "./api": { getBackendUrl: async () => "https://example.invalid" },
      "./currency": { CURRENCIES, DEFAULT_CURRENCY: "AFN" },
      "./db": db,
      "./money": require("../money"),
      "./phone": phone,
    },
    {
      fetch: async (url: string, init: { body: string; signal: AbortSignal }) => {
        assert.equal(url, "https://example.invalid/v1/sponsor-proposals");
        const submission = JSON.parse(init.body) as ProposalSubmission;
        requests.push(submission);
        return fetchReply(submission, init.signal);
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  ) as typeof import("../promotion-proposals");
  return {
    model,
    language,
    phone,
    storage,
    requests,
    writes,
    clock,
    set failWrite(value: boolean) {
      failWrite = value;
    },
    set reply(value: typeof fetchReply) {
      fetchReply = value;
    },
    get uuidCount() {
      return uuidCount;
    },
  };
}

function screen(env: ReturnType<typeof environment>, installId = "synthetic-install") {
  const hooks = uiHooks();
  const router = { canGoBack: () => true, back() {}, replace() {} };
  const component = compileUI(
    "../../app/promote",
    {
      "@expo/vector-icons": { Ionicons: "Icon" },
      "expo-router": { useRouter: () => router },
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        ActivityIndicator: "ActivityIndicator",
        Keyboard: { dismiss() {} },
        KeyboardAvoidingView: "KeyboardAvoidingView",
        Platform: { OS: "android" },
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (value: unknown) => value },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../components/Button": { Button: "Button" },
      "../components/CurrencyPickerSheet": { CurrencyPickerSheet: "CurrencyPickerSheet" },
      "../components/FormField": { FormField: "FormField", LTR_INPUT: {} },
      "../components/SettingsScreen": { NavRow: "NavRow", ScreenHeader: "ScreenHeader" },
      "../lib/colors": { colors: {} },
      "../lib/currency": { getCurrencyLabel: (code: string) => code },
      "../lib/db-tx": { getInstallIdSync: () => installId },
      "../lib/direction": {
        useIsRTL: () => env.language.getLocale() !== "en",
        textDir: () => ({}),
      },
      "../lib/i18n": env.language,
      "../lib/promotion-proposals": env.model,
      "../lib/tokens": { gutter: {}, space: {}, typography: {} },
    },
    { setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout },
  );
  hooks.render(() => component.default());
  const settle = async () => {
    await settleUI();
    hooks.render();
    await settleUI();
    hooks.render();
  };
  const field = (key: string) => {
    const found = nodes(hooks.tree).find(
      (item) => item.type === "FormField" && item.props.label === env.language.t(key as any),
    );
    assert.ok(found, `Missing proposal field ${key}`);
    return found;
  };
  const button = (key: string) => {
    const found = nodes(hooks.tree).find(
      (item) => item.type === "Button" && item.props.label === env.language.t(key as any),
    );
    assert.ok(found, `Missing proposal button ${key}`);
    return found;
  };
  const text = () =>
    nodes(hooks.tree)
      .filter((item) => item.type === "Text")
      .map((item) => item.props.children)
      .join("\n");
  return {
    hooks,
    settle,
    field,
    button,
    text,
    async change(key: string, value: string) {
      field(key).props.onChangeText(value);
      await settle();
    },
    async tap(key: string) {
      button(key).props.onPress();
      await settle();
    },
  };
}

async function savedEnvironment(locale: "en" | "fa" | "ps" = "en") {
  const env = environment(locale);
  const draft = { ...env.model.newProposalDraft(), fields: { ...validFields } };
  await env.model.saveProposalDraft("synthetic-install", draft);
  return env;
}

async function main() {
  for (const locale of ["en", "fa", "ps"] as const) {
    const env = environment(locale);
    const submission = env.model.prepareProposal(
      { ...validFields, phone: "۰۷۰۰۱۲۳۴۵۶", budget_amount: "۱۲٫۵۰" },
      locale,
    );
    assert.equal(submission.phone, "+93700123456");
    assert.equal(submission.budget_amount, "12.50");
    assert.equal(submission.app_locale, locale);
    assert.equal(
      env.model.prepareProposal({ ...validFields, budget_amount: "999999999999.99" }, locale)
        .budget_amount,
      "999999999999.99",
    );
    for (const amount of ["0", "-1", "1.001", "1000000000000", "1,234", "NaN"]) {
      assert.equal(
        env.model.validateProposal({ ...validFields, budget_amount: amount }).budget_amount,
        "promotion.invalidBudget",
      );
    }
    assert.equal(
      env.model.validateProposal({ ...validFields, phone: "invalid" }).phone,
      "promotion.invalidPhone",
    );
    assert.equal(
      env.model.validateProposal({ ...validFields, business_name: "😀".repeat(120) }).business_name,
      undefined,
    );
    assert.equal(
      env.model.validateProposal({ ...validFields, business_name: "😀".repeat(121) }).business_name,
      "promotion.tooLong",
    );
    const first = screen(env);
    await first.settle();
    await first.change("promotion.business", `Synthetic ${locale} draft`);
    await env.clock.advance(400, first.settle);
    assert.ok(first.text().includes(env.language.t("promotion.saved")));
    first.hooks.unmount();
    await settleUI();
    const reopened = screen(env);
    await reopened.settle();
    assert.equal(reopened.field("promotion.business").props.value, `Synthetic ${locale} draft`);
    reopened.hooks.unmount();
  }

  const retry = await savedEnvironment();
  retry.reply = async () => {
    throw new TypeError("Synthetic lost response");
  };
  const first = screen(retry);
  await first.settle();
  await first.tap("promotion.submit");
  assert.equal(retry.requests.length, 1);
  assert.ok(first.text().includes(retry.language.t("promotion.sendFailed")));
  assert.equal(first.field("promotion.business").props.editable, false);
  await first.change("promotion.business", "Changed while pending");
  assert.equal(first.field("promotion.business").props.value, validFields.business_name);
  first.hooks.unmount();
  await settleUI();
  retry.phone.setCurrentDefaultCountryCode("AU");
  const reopened = screen(retry);
  await reopened.settle();
  retry.reply = async (submission) => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: 37,
      submission_id: submission.submission_id,
      created_at: "2026-11-05T08:00:00Z",
    }),
  });
  await reopened.tap("promotion.retry");
  assert.deepEqual(
    retry.requests[1],
    retry.requests[0],
    "Ambiguous retry reuses the exact saved UUID and payload after reopening",
  );
  assert.equal(new Set(retry.requests.map((request) => request.submission_id)).size, 1);
  assert.ok(reopened.text().includes(retry.language.t("promotion.received")));
  const receiptDraft = await retry.model.readProposalDraft("synthetic-install");
  assert.equal(receiptDraft?.receipt?.id, 37);
  reopened.hooks.unmount();

  const invalidReceipt = await savedEnvironment();
  invalidReceipt.reply = async () => ({
    ok: true,
    status: 201,
    json: async () => ({
      id: 1,
      submission_id: "wrong-request",
      created_at: "2026-11-05T08:00:00Z",
    }),
  });
  const invalidScreen = screen(invalidReceipt);
  await invalidScreen.settle();
  await invalidScreen.tap("promotion.submit");
  assert.ok(
    !invalidScreen.text().includes(invalidReceipt.language.t("promotion.received")),
    "A mismatched receipt cannot report success",
  );
  assert.equal((await invalidReceipt.model.readProposalDraft("synthetic-install"))?.receipt, null);
  assert.ok((await invalidReceipt.model.readProposalDraft("synthetic-install"))?.pending);
  invalidScreen.hooks.unmount();

  const rejected = await savedEnvironment();
  rejected.reply = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "Synthetic rejection" }),
  });
  const rejectedScreen = screen(rejected);
  await rejectedScreen.settle();
  await rejectedScreen.tap("promotion.submit");
  assert.equal(rejectedScreen.field("promotion.business").props.editable, true);
  await rejectedScreen.change("promotion.business", "Corrected business");
  assert.equal(rejectedScreen.field("promotion.business").props.value, "Corrected business");
  assert.equal((await rejected.model.readProposalDraft("synthetic-install"))?.pending, null);
  rejectedScreen.hooks.unmount();

  const rejectedSaveFailure = await savedEnvironment();
  rejectedSaveFailure.reply = async () => {
    rejectedSaveFailure.failWrite = true;
    return { ok: false, status: 400, json: async () => ({ error: "Synthetic rejection" }) };
  };
  const rejectedSaveScreen = screen(rejectedSaveFailure);
  await rejectedSaveScreen.settle();
  await rejectedSaveScreen.tap("promotion.submit");
  assert.equal(
    rejectedSaveScreen.field("promotion.business").props.editable,
    false,
    "The form stays frozen if a definitive rejection cannot be saved locally",
  );
  assert.ok((await rejectedSaveFailure.model.readProposalDraft("synthetic-install"))?.pending);
  assert.ok(
    rejectedSaveScreen.text().includes(rejectedSaveFailure.language.t("promotion.saveFailed")),
  );
  rejectedSaveScreen.hooks.unmount();

  const timeout = await savedEnvironment();
  timeout.reply = async (_submission, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Synthetic timeout")), {
        once: true,
      });
    });
  const timeoutScreen = screen(timeout);
  await timeoutScreen.settle();
  await timeoutScreen.tap("promotion.submit");
  await timeout.clock.advance(15_000, timeoutScreen.settle);
  assert.equal(timeout.requests.length, 1);
  assert.ok((await timeout.model.readProposalDraft("synthetic-install"))?.pending);
  assert.ok(timeoutScreen.text().includes(timeout.language.t("promotion.sendFailed")));
  assert.ok(!timeoutScreen.text().includes(timeout.language.t("promotion.received")));
  timeoutScreen.hooks.unmount();

  const duplicate = await savedEnvironment();
  const gate = deferred<void>();
  duplicate.reply = async (submission) => {
    await gate.promise;
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: 38,
        submission_id: submission.submission_id,
        created_at: "2026-11-05T08:00:00Z",
      }),
    };
  };
  const duplicateScreen = screen(duplicate);
  await duplicateScreen.settle();
  const send = duplicateScreen.button("promotion.submit").props.onPress;
  send();
  send();
  await duplicateScreen.settle();
  assert.equal(duplicate.requests.length, 1, "Concurrent Send presses create one request");
  gate.resolve();
  await duplicateScreen.settle();
  assert.ok(duplicateScreen.text().includes(duplicate.language.t("promotion.received")));
  duplicateScreen.hooks.unmount();

  const storageFailure = await savedEnvironment();
  const storageScreen = screen(storageFailure);
  await storageScreen.settle();
  await storageFailure.clock.advance(400, storageScreen.settle);
  assert.ok(storageScreen.text().includes(storageFailure.language.t("promotion.saved")));
  storageFailure.failWrite = true;
  await storageScreen.tap("promotion.submit");
  assert.equal(
    storageFailure.requests.length,
    0,
    "A request is never submitted before its UUID/payload are saved locally",
  );
  assert.ok(storageScreen.text().includes(storageFailure.language.t("promotion.saveFailed")));
  assert.ok(
    !storageScreen.text().includes(storageFailure.language.t("promotion.saved")),
    "Failed local saves must not display a saved confirmation",
  );
  assert.equal(storageScreen.field("promotion.business").props.editable, true);
  storageScreen.hooks.unmount();

  const receiptSaveFailure = await savedEnvironment();
  receiptSaveFailure.reply = async (submission) => ({
    ok: true,
    status: 201,
    json: async () => {
      if (receiptSaveFailure.requests.length === 1) receiptSaveFailure.failWrite = true;
      return {
        id: 40,
        submission_id: submission.submission_id,
        created_at: "2026-11-05T08:00:00Z",
      };
    },
  });
  const receiptSaveScreen = screen(receiptSaveFailure);
  await receiptSaveScreen.settle();
  await receiptSaveScreen.tap("promotion.submit");
  assert.ok(receiptSaveScreen.text().includes(receiptSaveFailure.language.t("promotion.received")));
  assert.ok(
    receiptSaveScreen.text().includes(receiptSaveFailure.language.t("promotion.receiptSaveFailed")),
  );
  receiptSaveScreen.hooks.unmount();
  await settleUI();
  receiptSaveFailure.failWrite = false;
  const receiptReopen = screen(receiptSaveFailure);
  await receiptReopen.settle();
  await receiptReopen.tap("promotion.retry");
  assert.deepEqual(
    receiptSaveFailure.requests[1],
    receiptSaveFailure.requests[0],
    "Losing the local receipt does not create a second proposal",
  );
  assert.equal(
    (await receiptSaveFailure.model.readProposalDraft("synthetic-install"))?.receipt?.id,
    40,
  );
  receiptReopen.hooks.unmount();

  const receipts = environment();
  const payload = receipts.model.prepareProposal(validFields, "en");
  for (const receipt of [
    null,
    {},
    { id: 0, submission_id: payload.submission_id, created_at: "2026-11-05T08:00:00Z" },
    { id: 1, submission_id: payload.submission_id, created_at: "invalid" },
  ]) {
    receipts.reply = async () => ({ ok: true, status: 201, json: async () => receipt });
    await assert.rejects(receipts.model.submitProposal(payload));
  }

  const transitions = environment();
  const queued = environment();
  const latestDraft = { ...queued.model.newProposalDraft(), fields: { ...validFields } };
  const queuedSave = queued.model.saveProposalDraft("synthetic-install", latestDraft);
  const queuedRead = await queued.model.readProposalDraft("synthetic-install");
  assert.deepEqual(
    queuedRead,
    latestDraft,
    "Reopening waits for the previous screen's queued save",
  );
  await queuedSave;

  const completedElsewhere = environment();
  const pendingDraft = {
    ...completedElsewhere.model.newProposalDraft(),
    fields: { ...validFields },
    pending: completedElsewhere.model.prepareProposal(validFields, "en"),
  };
  await completedElsewhere.model.saveProposalDraft("synthetic-install", pendingDraft);
  const staleScreen = screen(completedElsewhere);
  await staleScreen.settle();
  await completedElsewhere.model.saveProposalDraft("synthetic-install", {
    ...pendingDraft,
    receipt: {
      id: 38,
      submission_id: pendingDraft.pending.submission_id,
      created_at: "2026-11-05T08:00:00Z",
    },
  });
  await staleScreen.tap("promotion.retry");
  assert.ok(staleScreen.text().includes(completedElsewhere.language.t("promotion.received")));
  assert.equal(
    completedElsewhere.requests.length,
    0,
    "An existing saved receipt needs no HTTP retry",
  );
  staleScreen.hooks.unmount();

  const original = { ...transitions.model.newProposalDraft(), fields: { ...validFields } };
  await transitions.model.saveProposalDraft("synthetic-install", original);
  const waiting = {
    ...original,
    pending: transitions.model.prepareProposal(original.fields, "en"),
  };
  await transitions.model.saveProposalDraft("synthetic-install", waiting);
  await assert.rejects(
    transitions.model.saveProposalDraft("synthetic-install", original),
    /awaiting confirmation/,
    "An older screen cannot restore editable fields over a pending request",
  );
  const received = {
    ...waiting,
    receipt: {
      id: 39,
      submission_id: waiting.pending.submission_id,
      created_at: "2026-11-05T08:00:00Z",
    },
  };
  const another = transitions.model.newProposalDraft();
  await Promise.all([
    transitions.model.saveProposalDraft("synthetic-install", received),
    transitions.model.saveProposalDraft("synthetic-install", another, {
      replaceDraftId: received.draft_id,
    }),
  ]);
  await assert.rejects(
    transitions.model.saveProposalDraft("synthetic-install", received),
    /replaced/,
    "A late receipt cannot overwrite a new proposal draft",
  );
  assert.equal(
    (await transitions.model.readProposalDraft("synthetic-install"))?.draft_id,
    another.draft_id,
  );
  const protectedReceipt = environment();
  await protectedReceipt.model.saveProposalDraft("synthetic-install", received);
  await assert.rejects(
    protectedReceipt.model.saveProposalDraft("synthetic-install", waiting),
    /already been received/,
  );
  assert.equal(
    (await protectedReceipt.model.readProposalDraft("synthetic-install"))?.receipt?.id,
    39,
  );

  const invalidSaved = environment();
  invalidSaved.storage.set(
    "promotion_proposal_draft:synthetic-install",
    JSON.stringify({ ...received, receipt: { ...received.receipt, submission_id: "other" } }),
  );
  await assert.rejects(
    invalidSaved.model.readProposalDraft("synthetic-install"),
    /Invalid saved receipt/,
  );

  const legacy = environment();
  legacy.storage.set(
    "promotion_proposal_draft:synthetic-install",
    JSON.stringify({
      fields: validFields,
      pending: null,
      receipt: null,
    }),
  );
  const legacyDraft = await legacy.model.readProposalDraft("synthetic-install");
  assert.equal(legacyDraft?.draft_id, "legacy");
  await legacy.model.saveProposalDraft("synthetic-install", legacyDraft!);
  assert.equal(
    JSON.parse(legacy.storage.get("promotion_proposal_draft:synthetic-install")!).draft_id,
    "legacy",
  );
  legacy.storage.set(
    "promotion_proposal_draft:synthetic-install",
    JSON.stringify({
      fields: waiting.fields,
      pending: waiting.pending,
      receipt: null,
    }),
  );
  const legacyPending = await legacy.model.readProposalDraft("synthetic-install");
  assert.equal(legacyPending?.draft_id, waiting.pending.submission_id);
  assert.deepEqual(
    legacyPending?.pending,
    waiting.pending,
    "Older pending drafts retain the exact request",
  );
  console.log(
    "PASS promotion proposals: EN/FA/PS input, exact amount/phone, durable drafts, idempotent retries, valid receipts, edit locks/rejection correction, timeout/local failures, duplicate Send and stale-screen write protection",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
