import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminTokenContext,
  saveSponsorProposal,
  sponsorProposalsKey,
  type SponsorProposal,
} from "./api";
import { selectSponsorProposals, SponsorProposals } from "./SponsorProposals";

function proposal(id: number, patch: Partial<SponsorProposal> = {}): SponsorProposal {
  return {
    id,
    submission_id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    business_name: `Synthetic business ${id}`,
    contact_name: "Synthetic owner",
    phone: "+93700000001",
    proposal: "A proposed product promotion",
    budget_amount: "100.00",
    budget_currency: "AFN",
    duration: "One week",
    app_locale: "en",
    status: "new",
    notes: "",
    created_at: `2026-11-05T00:00:0${id}Z`,
    updated_at: "2026-11-05T00:00:01.123456Z",
    ...patch,
  };
}
const filters = { search: "", status: "", currency: "", sort: "newest" as const };

test("offer comparisons require one currency and preserve exact cents at the supported maximum", () => {
  const proposals = [
    proposal(1, { budget_amount: "999999999999.98" }),
    proposal(2, { budget_amount: "999999999999.99" }),
    proposal(3, { budget_amount: "1", budget_currency: "USD" }),
  ];
  assert.deepEqual(
    selectSponsorProposals(proposals, { ...filters, sort: "highest" }).map((row) => row.id),
    [3, 2, 1],
    "Mixed currencies retain chronological order",
  );
  assert.deepEqual(
    selectSponsorProposals(proposals, { ...filters, currency: "AFN", sort: "highest" }).map(
      (row) => row.id,
    ),
    [2, 1],
  );
  assert.deepEqual(
    proposals.map((row) => row.id),
    [1, 2, 3],
    "Filtering never mutates received records",
  );
});

test("archived proposals remain available and search composes with status and currency", () => {
  const proposals = [
    proposal(1, { business_name: "Synthetic Flour", status: "archived" }),
    proposal(2, { business_name: "Synthetic Flour", budget_currency: "USD" }),
    proposal(3, { business_name: "Synthetic Oil" }),
  ];
  assert.equal(selectSponsorProposals(proposals, filters).length, 3);
  assert.deepEqual(
    selectSponsorProposals(proposals, {
      ...filters,
      search: " FLOUR ",
      status: "archived",
      currency: "AFN",
    }).map((row) => row.id),
    [1],
  );
  assert.equal(selectSponsorProposals(proposals, { ...filters, search: "700000001" }).length, 3);
});

test("the proposal inbox displays each offered currency and escapes submitted content", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(sponsorProposalsKey("synthetic"), {
    proposals: [
      proposal(1, { business_name: "<script>business</script>" }),
      proposal(2, { budget_currency: "USD" }),
    ],
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AdminTokenContext.Provider value="synthetic">
        <SponsorProposals />
      </AdminTokenContext.Provider>
    </QueryClientProvider>,
  );
  assert.match(html, /100 AFN/);
  assert.match(html, /100 USD/);
  assert.match(html, /2 received · 2 new/);
  assert.match(html, /Choose a currency to compare the highest offers/);
  assert.match(html, /&lt;script&gt;business&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>business/);
  client.clear();
});

test("review saves preserve the raw revision and expose stale-write errors", async () => {
  const originalFetch = globalThis.fetch;
  const row = proposal(1);
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(row), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await saveSponsorProposal("synthetic-key", row, { status: "reviewing", notes: "Follow up" });
    assert.match(calls[0].url, /\/v1\/admin\/sponsor-proposals\/1$/);
    assert.equal(calls[0].init?.method, "PUT");
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer synthetic-key",
    );
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      status: "reviewing",
      notes: "Follow up",
      expected_updated_at: row.updated_at,
    });
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "This proposal changed. Reopen it and try again." }), {
        status: 409,
      });
    await assert.rejects(
      saveSponsorProposal("synthetic-key", row, { status: "accepted", notes: "" }),
      /This proposal changed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
