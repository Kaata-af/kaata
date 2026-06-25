// Typed projection-applier errors.
//
// MissingPrereqError is thrown by an applier when the row it needs to mutate
// (an entry to amend, a person to rename, …) is not on disk YET. On the
// durable-ingest → sweep path (lib/projection/ingest-row.ts + sweep.ts) this
// throw is caught by applyAlreadyIngestedEvent → classifyApplierThrow and
// turned into a `missing_prereq` QUARANTINE — the row stays in event_log,
// applied_at=NULL, and a later sweep retries it once the prerequisite create
// lands (HLC order makes create sort before its amend, so they heal in one
// fixpoint pass).
//
// WHY A TYPED ERROR (not a silent return): the appliers used to `return`
// quietly on a missing target, because under the OLD pull path the applier
// shared one transaction with the event_log INSERT and THROWING would have
// rolled the row back (re-fetched forever / lost). But replay.ts counts a
// silent return as {applied} → the row exits quarantine permanently and is
// NEVER re-applied when the create finally arrives — its own silent-loss bug.
// Once ingest is decoupled from apply (the fundamental sync fix), throwing is
// the correct, loss-free behaviour: the row is already durably ingested, so
// the throw only re-quarantines it for retry. classifyApplierThrow matches
// this type explicitly so the verdict never depends on error-message strings.
export class MissingPrereqError extends Error {
  readonly kind = "missing_prereq" as const;
  constructor(message: string) {
    super(message);
    this.name = "MissingPrereqError";
  }
}
