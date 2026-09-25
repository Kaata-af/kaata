// apps/mobile/lib/tabs/errors.ts
//
// Every typed failure the tab layer can surface, in one dependency-free module
// so screens, lib/db.ts and the selftest can `instanceof` them without pulling
// in the network or SQLite halves. Each carries a `kind` discriminant in the
// SettledChapterError / RoleGateRejectionError style so a catch site can
// switch without instanceof chains across module boundaries.

import type { CreatePersonResult } from "../types";

/**
 * A local mutation (edit / delete / settle) targeted a contact whose account
 * is a linked tab. After linking, the tab IS the account (D8): its rows are
 * append-only server state, and the pre-link local rows are frozen because
 * their sum is already carried by the opening entry — editing either would
 * silently desync the two parties. Data-layer guard, like SettledChapterError.
 */
export class TabLinkedEntryError extends Error {
  readonly kind = "tab_linked" as const;
  constructor() {
    super("contact is linked to a mutual tab — its entries are immutable locally");
    this.name = "TabLinkedEntryError";
  }
}

/** Non-2xx from /v1/tabs/*, or a transport failure (status 0). `code` is the
 *  backend's stable error_code (§3.4), "timeout" / "network" for transport. */
export class TabApiError extends Error {
  readonly kind = "tab_api" as const;
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TabApiError";
    this.status = status;
    this.code = code;
  }
}

/** A shared-account request needs sign-in; a saved invitation is not authority. */
export class TabAuthUnavailableError extends Error {
  readonly kind = "tab_auth_unavailable" as const;
  constructor() {
    super("sign in to use this shared account");
    this.name = "TabAuthUnavailableError";
  }
}

/** D9: a tab can only live in a kaata whose currency equals the tab's. */
export class TabCurrencyMismatchError extends Error {
  readonly kind = "tab_currency_mismatch" as const;
  constructor(
    readonly vaultCurrency: string,
    readonly tabCurrency: string,
  ) {
    super(`kaata is ${vaultCurrency}, tab is ${tabCurrency}`);
    this.name = "TabCurrencyMismatchError";
  }
}

/** Server 409 same_kaata: both parties would be the same kaata. */
export class TabSameKaataError extends Error {
  readonly kind = "tab_same_kaata" as const;
  constructor() {
    super("both parties of a tab cannot be the same kaata");
    this.name = "TabSameKaataError";
  }
}

/** The contact already has an open tab (idx_tab_links_open_rel). */
export class TabAlreadyLinkedError extends Error {
  readonly kind = "tab_already_linked" as const;
  constructor(readonly tabId: string) {
    super(`contact already linked to tab ${tabId}`);
    this.name = "TabAlreadyLinkedError";
  }
}

/** The tab was closed by either party; every write is refused (reads still work). */
export class TabClosedError extends Error {
  readonly kind = "tab_closed" as const;
  constructor() {
    super("tab is closed");
    this.name = "TabClosedError";
  }
}

/** An accept/reject is final, including an already-queued offline decision. */
export class TabReviewFinalError extends Error {
  readonly kind = "tab_review_final" as const;
  constructor() {
    super("tally already reviewed; send a new tally instead");
    this.name = "TabReviewFinalError";
  }
}

/** Local input validation, so screens can map a code to copy without
 *  round-tripping to the server for what the phone can already see. */
export type TabInputErrorCode =
  | "label_required"
  | "reason_required"
  | "reason_too_long"
  | "amount_invalid"
  | "not_linked"
  | "no_active_vault"
  | "no_relationship"
  | "currency_unknown";

export class TabInputError extends Error {
  readonly kind = "tab_input" as const;
  constructor(readonly code: TabInputErrorCode) {
    super(`tab input rejected: ${code}`);
    this.name = "TabInputError";
  }
}

/** The vault role does not permit this (linking / accept / dispute / void
 *  need `entry.amend`, i.e. editor+). Mirrors the UI's canAmend gate so the
 *  refusal is a property of the data layer, not one screen. */
export class TabPermissionError extends Error {
  readonly kind = "tab_permission" as const;
  constructor() {
    super("vault role does not allow this tab operation");
    this.name = "TabPermissionError";
  }
}

/** createPerson refused the new contact during a join; `result` carries the
 *  same discriminated failure person/new.tsx already knows how to word. */
export class TabCreatePersonError extends Error {
  readonly kind = "tab_create_person" as const;
  constructor(readonly result: Exclude<CreatePersonResult, { ok: true }>) {
    super(`contact could not be created: ${result.error}`);
    this.name = "TabCreatePersonError";
  }
}

/**
 * Whether a failed request is worth retrying later (transport failure, 408,
 * 429, 5xx) or is a verdict the server will repeat forever (every other 4xx,
 * including tab_not_found, tab_closed, not_author, own_entry, already_voided).
 * Sync drops the op on a verdict and backs off on the rest. Pure, so the
 * selftest can pin the table.
 */
export function isRetryableTabError(err: unknown): boolean {
  if (!(err instanceof TabApiError)) return false;
  // An expired session is not a verdict about the tally. Retain it until
  // check-in refreshes the JWT or the user signs back in.
  return (
    err.status === 0 ||
    err.status === 401 ||
    err.status === 408 ||
    err.status === 429 ||
    err.status >= 500
  );
}
