import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  saveSponsorProposal,
  sponsorProposalsKey,
  useAdminToken,
  useSponsorProposals,
  type SponsorProposal,
  type SponsorProposalStatus,
} from "./api";
import { fmtDateTime } from "./dates";
import { Card, ErrorCard, PageHeader, SkeletonCard } from "./ui";

const statuses: { value: SponsorProposalStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "reviewing", label: "Reviewing" },
  { value: "contacted", label: "Contacted" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "archived", label: "Archived" },
];
const selectClass =
  "h-10 w-full min-w-0 rounded-md border border-input bg-white px-3 text-sm text-brand-ink";
const amountFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function budgetUnits(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function selectSponsorProposals(
  proposals: SponsorProposal[],
  filters: { search: string; status: string; currency: string; sort: "newest" | "highest" },
) {
  const search = filters.search.trim().toLocaleLowerCase();
  const visible = proposals.filter(
    (proposal) =>
      (!filters.status || proposal.status === filters.status) &&
      (!filters.currency || proposal.budget_currency === filters.currency) &&
      (!search ||
        [proposal.business_name, proposal.contact_name, proposal.phone, proposal.proposal].some(
          (value) => value.toLocaleLowerCase().includes(search),
        )),
  );
  return visible.sort((a, b) => {
    if (filters.sort === "highest" && filters.currency) {
      const difference = budgetUnits(b.budget_amount) - budgetUnits(a.budget_amount);
      if (difference !== 0n) return difference > 0n ? 1 : -1;
    }
    return Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id;
  });
}

function offeredBudget(proposal: SponsorProposal) {
  return `${amountFormat.format(Number(proposal.budget_amount))} ${proposal.budget_currency}`;
}

export function SponsorProposals() {
  const token = useAdminToken();
  const client = useQueryClient();
  const query = useSponsorProposals();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [currency, setCurrency] = useState("");
  const [sort, setSort] = useState<"newest" | "highest">("newest");
  const [review, setReview] = useState<SponsorProposal | null>(null);
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: (input: {
      proposal: SponsorProposal;
      status: SponsorProposalStatus;
      notes: string;
    }) => saveSponsorProposal(token, input.proposal, { status: input.status, notes: input.notes }),
    onSuccess: () => {
      setReview(null);
      setNotice("Proposal review saved.");
    },
    // Refetch after a lost response or revision conflict without resending the
    // write. The original review and its draft stay open when a write fails.
    onSettled: () => client.invalidateQueries({ queryKey: sponsorProposalsKey(token) }),
  });

  function openReview(proposal: SponsorProposal | null) {
    save.reset();
    setNotice("");
    setReview(proposal);
  }

  const proposals = query.data?.proposals ?? [];
  const currencies = Array.from(
    new Set(proposals.map((proposal) => proposal.budget_currency)),
  ).sort();
  const visible = selectSponsorProposals(proposals, { search, status, currency, sort });
  const newCount = proposals.filter((proposal) => proposal.status === "new").length;

  return (
    <div className="min-w-0 max-w-full">
      <PageHeader
        title="Promotion proposals"
        description="Review business proposals and offered budgets, then keep each conversation’s progress here."
      />
      <div className="flex min-w-0 flex-col gap-4">
        {notice ? (
          <p role="status" className="text-sm font-medium text-emerald-700">
            {notice}
          </p>
        ) : null}
        {review ? (
          <ProposalReview
            key={review.id}
            proposal={review}
            busy={save.isPending}
            saveError={save.error?.message}
            onClose={() => openReview(null)}
            onSave={(nextStatus, notes) =>
              save.mutate({ proposal: review, status: nextStatus, notes })
            }
          />
        ) : null}
        {query.isPending ? (
          <SkeletonCard lines={4} />
        ) : query.isError ? (
          <ErrorCard
            message={`Couldn’t load promotion proposals. ${query.error.message}`}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <Card title="All proposals" sub={`${proposals.length} received · ${newCount} new`}>
            <div className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="min-w-0 space-y-1.5 text-sm font-medium text-brand-ink">
                <span>Search</span>
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Business, contact or proposal"
                />
              </label>
              <label className="min-w-0 space-y-1.5 text-sm font-medium text-brand-ink">
                <span>Status</span>
                <select
                  className={selectClass}
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  <option value="">All statuses</option>
                  {statuses.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 space-y-1.5 text-sm font-medium text-brand-ink">
                <span>Offer currency</span>
                <select
                  className={selectClass}
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value);
                    setSort("newest");
                  }}
                >
                  <option value="">All currencies</option>
                  {currencies.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 space-y-1.5 text-sm font-medium text-brand-ink">
                <span>Order</span>
                <select
                  className={selectClass}
                  value={sort}
                  onChange={(event) => setSort(event.target.value as "newest" | "highest")}
                >
                  <option value="newest">Newest first</option>
                  <option value="highest" disabled={!currency}>
                    Highest offer first
                  </option>
                </select>
              </label>
            </div>
            {!currency && proposals.length > 0 ? (
              <p className="mb-4 text-xs text-brand-muted">
                Choose a currency to compare the highest offers.
              </p>
            ) : null}
            {visible.length === 0 ? (
              <p className="text-sm text-brand-muted">
                {proposals.length === 0
                  ? "No promotion proposals yet."
                  : "No proposals match these filters."}
              </p>
            ) : (
              <ul className="divide-y divide-brand-faint">
                {visible.map((proposal) => (
                  <li
                    key={proposal.id}
                    className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-4 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1 basis-64">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span
                          dir="auto"
                          className="min-w-0 text-sm font-semibold text-brand-ink [overflow-wrap:anywhere]"
                        >
                          {proposal.business_name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${proposal.status === "new" ? "bg-amber-50 text-amber-800" : "bg-brand-ivory text-brand-sub"}`}
                        >
                          {statuses.find((item) => item.value === proposal.status)?.label ??
                            proposal.status}
                        </span>
                      </div>
                      <p dir="auto" className="mt-1 break-words text-sm text-brand-sub">
                        {proposal.contact_name} · <bdi dir="ltr">{proposal.phone}</bdi>
                      </p>
                      <p
                        dir="auto"
                        className="mt-2 whitespace-pre-wrap break-words text-sm text-brand-sub line-clamp-2"
                      >
                        {proposal.proposal}
                      </p>
                      <p className="mt-2 text-xs text-brand-muted">
                        Received {fmtDateTime(proposal.created_at)} Kabul · #{proposal.id}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                      <p className="text-sm font-semibold tabular-nums text-brand-ink">
                        {offeredBudget(proposal)}
                      </p>
                      {proposal.duration ? (
                        <p dir="auto" className="max-w-xs break-words text-xs text-brand-muted">
                          {proposal.duration}
                        </p>
                      ) : null}
                      <Button
                        variant="outline"
                        aria-label={`Review proposal from ${proposal.business_name}`}
                        disabled={Boolean(review)}
                        onClick={() => openReview(proposal)}
                      >
                        Review
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function ProposalReview({
  proposal,
  busy,
  saveError,
  onClose,
  onSave,
}: {
  proposal: SponsorProposal;
  busy: boolean;
  saveError?: string;
  onClose: () => void;
  onSave: (status: SponsorProposalStatus, notes: string) => void;
}) {
  const [validationError, setValidationError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const notes = String(form.get("notes") ?? "");
    if (Array.from(notes).length > 5000) {
      setValidationError("Notes can have up to 5,000 characters.");
      return;
    }
    setValidationError("");
    onSave(String(form.get("status")) as SponsorProposalStatus, notes);
  }

  return (
    <Card
      title={proposal.business_name}
      sub={`Proposal #${proposal.id} · received ${fmtDateTime(proposal.created_at)} Kabul`}
    >
      <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-brand-muted">Contact</dt>
          <dd dir="auto" className="mt-1 break-words text-brand-ink">
            {proposal.contact_name} · <bdi dir="ltr">{proposal.phone}</bdi>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-brand-muted">Offered budget</dt>
          <dd className="mt-1 font-semibold tabular-nums text-brand-ink">
            {offeredBudget(proposal)}
          </dd>
        </div>
        {proposal.duration ? (
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-xs text-brand-muted">Preferred timing or duration</dt>
            <dd dir="auto" className="mt-1 whitespace-pre-wrap break-words text-brand-ink">
              {proposal.duration}
            </dd>
          </div>
        ) : null}
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-brand-muted">Proposal</dt>
          <dd dir="auto" className="mt-1 whitespace-pre-wrap break-words text-brand-ink">
            {proposal.proposal}
          </dd>
        </div>
      </dl>
      <form onSubmit={submit} className="mt-5 border-t border-brand-faint pt-5">
        <fieldset disabled={busy} className="grid min-w-0 gap-4">
          <label className="max-w-xs space-y-1.5 text-sm font-medium text-brand-ink">
            <span>Status</span>
            <select name="status" className={selectClass} defaultValue={proposal.status}>
              {statuses.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 space-y-1.5 text-sm font-medium text-brand-ink">
            <span>Internal notes</span>
            <textarea
              name="notes"
              defaultValue={proposal.notes}
              dir="auto"
              rows={5}
              className="w-full min-w-0 rounded-md border border-input bg-white px-3 py-2 text-sm font-normal text-brand-ink"
              placeholder="Keep follow-ups, negotiated terms and next steps here."
            />
          </label>
          <p className="text-xs text-brand-muted">
            Notes and status are for Kaata operators. Original submitted details stay attached to
            this proposal.
          </p>
        </fieldset>
        {validationError || saveError ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {validationError || saveError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save review"}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Close review
          </Button>
        </div>
      </form>
    </Card>
  );
}
