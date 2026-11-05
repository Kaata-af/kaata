import { randomUUID } from "expo-crypto";
import { getBackendUrl } from "./api";
import { getAppMeta, setAppMeta } from "./db";
import type { LocaleCode } from "./i18n";
import { getCurrentDefaultCountryCode, normalizePhone } from "./phone";

export type ProposalFields = {
  proposal: string;
  budget_offer: string;
  duration: string;
};
export type ProposalContact = { business_name: string; contact_name: string; phone: string };
export type ProposalSubmission = ProposalContact & {
  proposal: string;
  duration: string;
  submission_id: string;
  app_locale: LocaleCode;
  budget_offer?: string;
  budget_amount?: string;
  budget_currency?: string;
};
export type ProposalReceipt = { id: number; submission_id: string; created_at: string };
export type ProposalDraft = {
  draft_id: string;
  fields: ProposalFields;
  pending: ProposalSubmission | null;
  receipt: ProposalReceipt | null;
};
export type ProposalErrors = Partial<
  Record<keyof ProposalFields, "promotion.required" | "promotion.tooLong">
>;

const emptyFields: ProposalFields = {
  proposal: "",
  budget_offer: "",
  duration: "",
};

export function newProposalDraft(): ProposalDraft {
  return {
    draft_id: randomUUID(),
    fields: { ...emptyFields },
    pending: null,
    receipt: null,
  };
}

export function validateProposal(fields: ProposalFields): ProposalErrors {
  const errors: ProposalErrors = {};
  for (const [field, limit] of [
    ["proposal", 3000],
    ["budget_offer", 1000],
    ["duration", 120],
  ] as const) {
    const value = fields[field].trim();
    if (!value && field !== "duration") errors[field] = "promotion.required";
    else if (Array.from(value).length > limit) errors[field] = "promotion.tooLong";
  }
  return errors;
}

export function prepareProposal(
  fields: ProposalFields,
  locale: LocaleCode,
  contact: ProposalContact,
): ProposalSubmission {
  if (Object.keys(validateProposal(fields)).length) throw new Error("Invalid proposal");
  const phone = normalizePhone(contact.phone, getCurrentDefaultCountryCode());
  return {
    // Fit the saved-profile snapshot to the proposal's stored bounds.
    business_name: Array.from(contact.business_name.trim()).slice(0, 120).join(""),
    contact_name: Array.from(contact.contact_name.trim()).slice(0, 100).join(""),
    phone: phone && /^\+[1-9]\d{6,14}$/.test(phone) ? phone : "",
    proposal: fields.proposal.trim(),
    budget_offer: fields.budget_offer.trim(),
    duration: fields.duration.trim(),
    app_locale: locale,
    submission_id: randomUUID(),
  };
}

const draftKey = (installId: string) => `promotion_proposal_draft:${installId}`;

async function readStoredProposalDraft(installId: string): Promise<ProposalDraft | null> {
  const raw = await getAppMeta(draftKey(installId));
  if (!raw) return null;
  const draft = JSON.parse(raw) as ProposalDraft;
  const legacy = draft?.fields as
    | (ProposalFields & { budget_amount?: string; budget_currency?: string })
    | undefined;
  if (legacy && legacy.budget_offer === undefined && typeof legacy.budget_amount === "string") {
    draft.fields = {
      proposal: legacy.proposal,
      budget_offer: legacy.budget_amount.trim()
        ? `${legacy.budget_amount} ${legacy.budget_currency ?? ""}`.trim()
        : "",
      duration: legacy.duration,
    };
  }
  const fields = Object.keys(emptyFields) as Array<keyof ProposalFields>;
  if (!draft?.fields || fields.some((field) => typeof draft.fields[field] !== "string")) {
    throw new Error("Invalid saved proposal");
  }
  // Keep drafts saved by the first form preview readable after an update.
  draft.draft_id ??= draft.pending?.submission_id ?? "legacy";
  if (typeof draft.draft_id !== "string" || !draft.draft_id) {
    throw new Error("Invalid saved proposal identity");
  }
  if (
    draft.pending &&
    (["business_name", "contact_name", "phone", "proposal", "duration"].some(
      (field) => typeof draft.pending?.[field as keyof ProposalSubmission] !== "string",
    ) ||
      !(
        typeof draft.pending.budget_offer === "string" ||
        (typeof draft.pending.budget_amount === "string" &&
          typeof draft.pending.budget_currency === "string")
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        draft.pending.submission_id,
      ) ||
      !["en", "fa", "ps"].includes(draft.pending.app_locale))
  ) {
    throw new Error("Invalid pending proposal");
  }
  if (
    draft.receipt &&
    (!Number.isSafeInteger(draft.receipt.id) ||
      draft.receipt.id <= 0 ||
      draft.receipt.submission_id !== draft.pending?.submission_id ||
      !Number.isFinite(Date.parse(draft.receipt.created_at)))
  ) {
    throw new Error("Invalid saved receipt");
  }
  return draft;
}

export type ProposalDraftTransition = { replaceDraftId?: string; rejectedSubmissionId?: string };
let draftWrites = Promise.resolve();

export class ProposalDraftConflictError extends Error {
  constructor(
    public latest: ProposalDraft,
    message: string,
  ) {
    super(message);
  }
}

export async function readProposalDraft(installId: string): Promise<ProposalDraft | null> {
  // A reopened form must see the previous screen's final queued save.
  await draftWrites.catch(() => {});
  return readStoredProposalDraft(installId);
}

export function saveProposalDraft(
  installId: string,
  draft: ProposalDraft,
  transition: ProposalDraftTransition = {},
): Promise<void> {
  const write = draftWrites
    .catch(() => {})
    .then(async () => {
      const stored = await readStoredProposalDraft(installId);
      if (stored && stored.draft_id !== draft.draft_id) {
        if (transition.replaceDraftId !== stored.draft_id || !stored.receipt) {
          throw new ProposalDraftConflictError(stored, "This draft has been replaced");
        }
      } else if (stored) {
        // Old screen callbacks may finish after the form has been reopened.
        // A saved request and receipt must only move forward.
        if (stored.receipt && stored.receipt.id !== draft.receipt?.id) {
          throw new ProposalDraftConflictError(stored, "This proposal has already been received");
        }
        if (
          stored.pending &&
          stored.pending.submission_id !== draft.pending?.submission_id &&
          (draft.pending || transition.rejectedSubmissionId !== stored.pending.submission_id)
        ) {
          throw new ProposalDraftConflictError(stored, "This proposal is awaiting confirmation");
        }
      }
      await setAppMeta(draftKey(installId), JSON.stringify(draft));
    });
  draftWrites = write;
  return write;
}

export class ProposalSubmissionError extends Error {
  constructor(public status: number) {
    super(`Proposal submission failed (${status})`);
  }
}

export async function submitProposal(submission: ProposalSubmission): Promise<ProposalReceipt> {
  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}/v1/sponsor-proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
      signal: controller.signal,
    });
    if (!response.ok) throw new ProposalSubmissionError(response.status);
    const receipt: ProposalReceipt = await response.json();
    if (
      !Number.isSafeInteger(receipt.id) ||
      receipt.id <= 0 ||
      receipt.submission_id !== submission.submission_id ||
      !Number.isFinite(Date.parse(receipt.created_at))
    ) {
      throw new Error("Invalid proposal receipt");
    }
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}
