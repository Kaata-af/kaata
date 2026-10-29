/** Shared authoring/replay rules for internal, per-Kaata customer notes. */
export const CUSTOMER_NOTE_MAX_LENGTH = 2000;

export class CustomerNoteChangedError extends Error {
  constructor() {
    super("Customer note changed; reopen the contact and try again");
    this.name = "CustomerNoteChangedError";
  }
}

export function isValidCustomerNote(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Array.from(value).length <= CUSTOMER_NOTE_MAX_LENGTH)
  );
}

export function normalizeCustomerNote(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid customer note");
  const note = value.trim();
  if (!isValidCustomerNote(note)) throw new Error("Customer note is too long");
  return note || null;
}
