// The tally just saved from the entry form, so the person screen can make
// sure it is on screen: with a search or date filter on, a new tally that did
// not match it used to vanish right after saving (audit #3).
let recent: { personId: string; entryId: string } | null = null;

export function noteSavedEntry(personId: string, entryId: string): void {
  recent = { personId, entryId };
}

/** Once per save: the first person screen load for that person takes it. */
export function takeSavedEntry(personId: string): string | null {
  if (!recent || recent.personId !== personId) return null;
  const { entryId } = recent;
  recent = null;
  return entryId;
}
