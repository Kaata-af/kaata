import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstallRow, UserRow, UsersResult } from "./api";
import { accountPlatforms, platformFacets, platformsLabel } from "./platforms.ts";
import {
  DEFAULT_FILTERS,
  activePreset,
  filterUsers,
  installTime,
  matchesActivity,
  parsePreferences,
  presetFilters,
  quickDateRange,
  reportedDevices,
  reportedRows,
  sortUsers,
  userRows,
} from "./users-model.ts";

const NOW = Date.parse("2026-09-13T20:00:00Z"); // September 14, 00:30 in Kabul.
function install(id: string, overrides: Partial<InstallRow> = {}): InstallRow {
  return {
    install_id: id,
    self_name: "Ahmad",
    self_phone: "+93700123456",
    shop_name: "Sabz Grocery",
    platform: "android",
    app_version: "1.0.9",
    locale: "fa",
    installed_at: "2026-09-01T20:00:00Z",
    first_seen: "2026-09-01T20:00:00Z",
    last_seen: "2026-09-13T19:45:00Z",
    last_activity_at: "",
    has_onboarded: true,
    source: "market-qr",
    attribution_method: "qr",
    usage_entries: 3,
    usage_customers: 2,
    usage_shares: 1,
    check_in_count: 5,
    ...overrides,
  };
}
function account(overrides: Partial<UserRow> = {}): UserRow {
  return {
    account_id: "account-1",
    name: "Sara",
    email: "sara@example.test",
    locale: "en",
    created_at: "",
    last_login_at: "",
    last_seen: "2026-09-05T20:00:00Z",
    ledger_name: "",
    ledger_phone: "",
    shop_name: "Sara Shop",
    platform: "iOS",
    app_version: "1.0.8",
    installed_at: "",
    first_seen: "2026-09-01T20:00:00Z",
    last_activity_at: "",
    has_onboarded: true,
    source: "",
    install_count: 2,
    kaatas: [
      {
        vault_id: "vault-1",
        name: "Shop",
        role: "owner",
        archived: false,
        member_count: 1,
        tally_count: 12,
        customer_count: 4,
        members: [],
      },
    ],
    ...overrides,
  };
}
function data(installs: InstallRow[] = [], users: UserRow[] = []): UsersResult {
  return {
    users,
    anonymous_installs: installs,
    signed_in_count: users.length,
    anonymous_count: installs.length,
    total_installs: installs.length + users.reduce((sum, u) => sum + u.install_count, 0),
    generated_at: "",
  };
}

test("rows retain account versus device units, date fallback, Kabul install day and reported totals", () => {
  const rows = userRows(data([install("device-1")], [account()]));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["a:account-1", "i:device-1"],
  );
  // 20:00 UTC is 00:30 the next morning in Kabul: the day the row shows.
  assert.equal(rows[0].installed_at, "2026-09-01T20:00:00Z");
  assert.equal(rows[0].installed_day, "2026-09-02");
  assert.equal(rows[0].platform, "ios");
  assert.equal(rows[0].entries, 12);
  assert.equal(rows[0].shares, null);
  assert.equal(rows[1].shares, 1);
  assert.equal(rows[1].installed_day, "2026-09-02");
  assert.equal(rows[0].excluded, false);
  assert.equal(rows[1].excludedBy, "");
  assert.deepEqual(userRows(undefined), []);
});

test("the install time is the earlier of the device's mint time and the server's first record", () => {
  // Device clock first (installed offline, checked in later).
  assert.equal(installTime("2026-09-01T08:00:00Z", "2026-09-01T18:00:00Z"), "2026-09-01T08:00:00Z");
  // A legacy install whose installed_at was back-filled by a later check-in.
  assert.equal(installTime("2026-06-02T10:00:00Z", "2026-05-17T09:00:00Z"), "2026-05-17T09:00:00Z");
  assert.equal(installTime("", "2026-05-17T09:00:00Z"), "2026-05-17T09:00:00Z");
  assert.equal(installTime("not a timestamp", undefined), "");
  assert.equal(installTime(undefined, undefined), "");
  const [legacy] = userRows(
    data([
      install("legacy", {
        installed_at: "2026-06-02T10:00:00Z",
        first_seen: "2026-05-17T09:00:00Z",
      }),
    ]),
  );
  assert.equal(legacy.installed_at, "2026-05-17T09:00:00Z");
  assert.equal(legacy.installed_day, "2026-05-17");
});

test("one account displays every platform and matches any platform without duplicate people", () => {
  const rows = userRows(
    data(
      [],
      [
        account({
          platform: "web",
          platforms: ["iOS", "android", " Web ", "ios", "", "__unknown__"],
          install_count: 2,
        }),
      ],
    ),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].platforms, ["android", "ios", "web"]);
  assert.equal(platformsLabel(rows[0].platforms), "Android · iOS · Web");
  for (const platform of ["ios", "android", "web"]) {
    const matches = filterUsers(rows, { ...DEFAULT_FILTERS, platform }, "", NOW).visible;
    assert.deepEqual(
      matches.map((row) => row.id),
      ["a:account-1"],
    );
  }
  assert.equal(
    filterUsers(rows, { ...DEFAULT_FILTERS, platform: "__unknown__" }, "", NOW).visible.length,
    0,
  );
  assert.equal(reportedDevices(rows), 2);
});

test("platform rollout keeps latest values, nonstandard labels and true unknowns", () => {
  const rows = userRows(data([install("unknown", { platform: "" })], [account()]));
  assert.deepEqual(rows[0].platforms, ["ios"]);
  assert.deepEqual(platformFacets(rows[1].platforms), ["__unknown__"]);
  assert.deepEqual(accountPlatforms(["linux", " Linux ", "unknown"], "web"), ["linux", "web"]);
  assert.equal(platformsLabel(undefined, "web"), "Web");
  assert.equal(platformsLabel([]), "Unknown");
  assert.deepEqual(
    filterUsers(rows, { ...DEFAULT_FILTERS, platform: "__unknown__" }, "", NOW).visible.map(
      (r) => r.id,
    ),
    ["i:unknown"],
  );
});

test("facets combine with search across profile fields and normalized phone digits", () => {
  const rows = userRows(
    data(
      [
        install("match"),
        install("other-version", { app_version: "1.0.8" }),
        install("other-source", { source: "street" }),
        install("not-onboarded", { has_onboarded: false }),
        install("no-entries", { usage_entries: 0 }),
      ],
      [account()],
    ),
  );
  const filters = {
    ...DEFAULT_FILTERS,
    signIn: "signed-out" as const,
    onboarding: "complete" as const,
    platform: "android",
    language: "fa",
    source: "market-qr",
    version: "1.0.9",
    entries: "with" as const,
    contact: "available" as const,
    activity: "today" as const,
  };
  assert.deepEqual(
    filterUsers(rows, filters, "AHMAD grocery", NOW).visible.map((row) => row.id),
    ["i:match"],
  );
  assert.deepEqual(
    filterUsers(rows, filters, "+۹۳ (۷۰۰) ۱۲۳-۴۵۶", NOW).visible.map((row) => row.id),
    ["i:match"],
  );
  assert.deepEqual(
    filterUsers(rows, filters, "0700 123 456", NOW).visible.map((row) => row.id),
    ["i:match"],
  );
  assert.deepEqual(
    filterUsers(rows, DEFAULT_FILTERS, "SARA@EXAMPLE.TEST", NOW).visible.map((row) => row.id),
    ["a:account-1"],
  );
  assert.equal(filterUsers(rows, filters, "Ahmad missing-word", NOW).visible.length, 0);
});

test("unidentified counts reflect the other filters and remain explicit when hidden", () => {
  const rows = userRows(
    data([
      install("named"),
      install("anonymous", { self_name: "", self_phone: "", shop_name: "" }),
      install("anonymous-ios", { self_name: "", self_phone: "", shop_name: "", platform: "ios" }),
    ]),
  );
  const result = filterUsers(rows, { ...DEFAULT_FILTERS, platform: "android" }, "", NOW);
  assert.equal(result.matching.length, 2);
  assert.equal(result.identified, 1);
  assert.equal(result.unidentified, 1);
  assert.equal(result.hidden, 1);
  assert.equal(result.visible.length, 1);
  const included = filterUsers(
    rows,
    { ...DEFAULT_FILTERS, platform: "android", includeUnidentified: true },
    "",
    NOW,
  );
  assert.equal(included.visible.length, 2);
  assert.equal(included.hidden, 0);
});

test("inclusive install ranges compare the Kabul day each row shows, old installs included", () => {
  const at = (value: string) => ({ installed_at: value, first_seen: value });
  const rows = userRows(
    data([
      install("history"),
      install("before", at("2026-09-12T19:29:59Z")),
      install("boundary", at("2026-09-12T19:30:00Z")),
      install("missing", { installed_at: "", first_seen: "" }),
    ]),
  );
  // "history" was installed at 20:00 UTC on Sep 1 — Sep 2, 00:30 in Kabul,
  // which is what the row shows, so a Sep 1 filter does not list it.
  assert.deepEqual(
    filterUsers(rows, { ...DEFAULT_FILTERS, from: "2026-09-01", to: "2026-09-01" }, "", NOW)
      .visible,
    [],
  );
  assert.deepEqual(
    filterUsers(
      rows,
      { ...DEFAULT_FILTERS, from: "2026-09-02", to: "2026-09-12" },
      "",
      NOW,
    ).visible.map((r) => r.id),
    ["i:history", "i:before"],
  );
  assert.deepEqual(
    filterUsers(
      rows,
      { ...DEFAULT_FILTERS, from: "2026-09-13", to: "2026-09-13" },
      "",
      NOW,
    ).visible.map((r) => r.id),
    ["i:boundary"],
  );
  assert.equal(
    filterUsers(rows, { ...DEFAULT_FILTERS, from: "2026-09-14", to: "2026-09-13" }, "", NOW)
      .matching.length,
    0,
  );
});

test("today follows Kabul midnight while recency uses elapsed time and rejects future timestamps", () => {
  const [yesterday, today, weekOld, invalid, future] = userRows(
    data([
      install("yesterday", { last_seen: "2026-09-13T19:29:59Z" }),
      install("today", { last_seen: "2026-09-13T19:30:00Z" }),
      install("week-old", { last_seen: new Date(NOW - 7 * 86_400_000).toISOString() }),
      install("invalid", { last_seen: "invalid" }),
      install("future", { last_seen: new Date(NOW + 1).toISOString() }),
    ]),
  );
  assert.equal(matchesActivity(yesterday, "today", NOW), false);
  assert.equal(matchesActivity(today, "today", NOW), true);
  assert.equal(matchesActivity(weekOld, "7d", NOW), false);
  assert.equal(matchesActivity(weekOld, "inactive", NOW), true);
  assert.equal(matchesActivity(invalid, "7d", NOW), false);
  assert.equal(matchesActivity(future, "online", NOW), false);
  assert.equal(matchesActivity(invalid, "never", NOW), true);
});

test("active and onboarding presets have explicit useful definitions", () => {
  const rows = userRows(
    data(
      [
        install("active"),
        install("unreachable", { last_seen: "2026-09-01T10:00:00Z", self_phone: "" }),
        install("not-onboarded", {
          self_name: "",
          self_phone: "",
          shop_name: "",
          has_onboarded: false,
        }),
        install("not-seen", { last_seen: "" }),
      ],
      [account()],
    ),
  );
  // The old "needs follow-up" preset (onboarded, inactive, reachable) is gone
  // on purpose: outreach has its own section (outreach-model.ts, 2026-09-29)
  // and the Users directory stays a reporting surface.
  assert.deepEqual(
    filterUsers(rows, presetFilters("active"), "", NOW).visible.map((r) => r.id),
    ["i:active"],
  );
  assert.deepEqual(
    filterUsers(rows, presetFilters("onboarding"), "", NOW).visible.map((r) => r.id),
    ["i:not-onboarded"],
  );
  assert.equal(activePreset(presetFilters("active")), "active");
  assert.equal(activePreset({ ...presetFilters("active"), platform: "ios" }), undefined);
});

test("unknown facets and no-entry/contact filters never drop a zero or unknown value silently", () => {
  const rows = userRows(
    data([
      install("unknown", {
        source: "",
        locale: "",
        app_version: "",
        usage_entries: 0,
        self_phone: "",
      }),
      install("known"),
    ]),
  );
  assert.deepEqual(
    filterUsers(
      rows,
      {
        ...DEFAULT_FILTERS,
        source: "__unknown__",
        language: "__unknown__",
        version: "__unknown__",
        entries: "without",
        contact: "missing",
      },
      "",
      NOW,
    ).visible.map((r) => r.id),
    ["i:unknown"],
  );
});

test("sorting compares timestamp instants and keeps missing values last in both directions", () => {
  const rows = userRows(
    data(
      [
        install("earlier", { last_seen: "2026-09-13T20:00:00+04:30", usage_shares: 0 }),
        install("later", { last_seen: "2026-09-13T17:00:00Z", usage_shares: 3 }),
        install("missing", { last_seen: "" }),
      ],
      [account()],
    ),
  );
  assert.deepEqual(
    sortUsers(rows.slice(1), "last_seen", true).map((r) => r.id),
    ["i:later", "i:earlier", "i:missing"],
  );
  assert.equal(sortUsers(rows, "shares", true).at(-1)?.id, "a:account-1");
  assert.equal(sortUsers(rows, "shares", false).at(-1)?.id, "a:account-1");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a:account-1", "i:earlier", "i:later", "i:missing"],
  );
});

test("preferences restore only whitelisted fields and never search or user identities", () => {
  const restored = parsePreferences({
    filters: {
      platform: "ios",
      search: "private phone",
      from: "2026-02-30",
      to: "2026-09-14",
      onboarding: "invalid",
      includeUnidentified: true,
    },
    search: "private name",
    expanded: { "account-id": true },
    sortKey: "name",
    sortDesc: false,
    pageSize: 50,
  });
  assert.equal(restored.filters.platform, "ios");
  assert.equal(restored.filters.from, "");
  assert.equal(restored.filters.to, "2026-09-14");
  assert.equal(restored.filters.onboarding, "all");
  assert.equal(restored.pageSize, 50);
  assert.equal(JSON.stringify(restored).includes("private"), false);
  assert.equal(JSON.stringify(restored).includes("account-id"), false);
  assert.equal(parsePreferences({ pageSize: 999 }).pageSize, 25);
});

test("test data is hidden by default, counted, and shown with its reason on request", () => {
  const rows = userRows(
    data(
      [
        install("robot", {
          self_name: "Pixel robot",
          excluded: true,
          excluded_by: "install",
          exclusion_reason: "robot",
        }),
        install("old-operator-phone", { excluded: true, excluded_by: "operator" }),
        install("real"),
        // A backend that predates exclusions sends no flags: counted.
        install("legacy"),
      ],
      [
        account({
          account_id: "qa",
          excluded: true,
          exclusion_reason: "QA",
          install_count: 1,
          excluded_installs: 1,
        }),
        account({ account_id: "shop", install_count: 3, excluded_installs: 1 }),
      ],
    ),
  );
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId["i:robot"].excludedBy, "install");
  assert.equal(byId["i:robot"].exclusionReason, "robot");
  assert.equal(byId["i:old-operator-phone"].excludedBy, "operator");
  assert.equal(byId["a:qa"].excludedBy, "account");
  assert.equal(byId["a:shop"].excluded, false);
  assert.equal(byId["a:shop"].excludedDevices, 1);

  const hidden = filterUsers(rows, DEFAULT_FILTERS, "", NOW);
  assert.deepEqual(hidden.visible.map((row) => row.id).sort(), ["a:shop", "i:legacy", "i:real"]);
  assert.equal(hidden.excluded, 3);
  assert.equal(hidden.excludedHidden, 3);
  // Hidden test data never counts as unidentified or identified.
  assert.equal(hidden.identified + hidden.unidentified, hidden.matching.length);

  const shown = filterUsers(rows, { ...DEFAULT_FILTERS, includeExcluded: true }, "", NOW);
  assert.equal(shown.visible.length, 6);
  assert.equal(shown.excluded, 3);
  assert.equal(shown.excludedHidden, 0);
  // A search that only matches test data finds nothing visible but reports
  // the hidden match, so the page can offer to show it.
  const onlyTest = filterUsers(rows, DEFAULT_FILTERS, "Pixel", NOW);
  assert.equal(onlyTest.visible.length, 0);
  assert.equal(onlyTest.excludedHidden, 1);
  assert.equal(filterUsers(rows, DEFAULT_FILTERS, "Ahmad", NOW).excludedHidden, 1);

  // Counted rows and devices leave test data out: 2 shop devices + 2 installs.
  assert.equal(reportedRows(rows).length, 3);
  assert.equal(reportedDevices(rows), 4);
  assert.equal(activePreset({ ...DEFAULT_FILTERS, includeExcluded: true }), undefined);
  assert.equal(
    parsePreferences({ filters: { includeExcluded: true } }).filters.includeExcluded,
    true,
  );
  assert.equal(
    parsePreferences({ filters: { includeExcluded: "yes" } }).filters.includeExcluded,
    false,
  );
});

test("quick ranges include today and cross calendar months without browser timezone drift", () => {
  assert.deepEqual(quickDateRange(1, NOW), { from: "2026-09-14", to: "2026-09-14" });
  assert.deepEqual(quickDateRange(7, Date.parse("2028-03-01T19:30:00Z")), {
    from: "2028-02-25",
    to: "2028-03-02",
  });
});
