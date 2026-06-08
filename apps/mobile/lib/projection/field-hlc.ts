// Per-field LWW bookkeeping shared by entries/persons/shop appliers.
//
// All mutable-field appliers funnel through this module so the JSON layout,
// the "missing field" semantics, and the comparison rule live in exactly one
// place. If we ever migrate to sidecar columns (Option A) only this file
// changes; the appliers stay the same.
//
// Per migration 009, every entity that needs per-field LWW has a nullable
// `field_hlcs TEXT` column constrained by CHECK json_valid(...). The applier
// reads the column, decides per-field whether to apply, writes back the
// merged map. NULL collapses to {} via parseFieldHLCs; missing fields
// resolve to FIELD_HLC_INIT (which is < every real HLC under compareHLC).

import { FIELD_HLC_INIT } from "../db";
import { compareHLC, type HLC } from "../hlc";

export type FieldHLCMap = Record<string, HLC>;

export type FieldDecision = "apply" | "skip";

/**
 * Parse the JSON sidecar. NULL / empty / corrupt JSON all collapse to {} —
 * a missing field is treated as FIELD_HLC_INIT by readFieldHLC, so the
 * first real event always wins.
 *
 * Corrupt JSON shouldn't happen (CHECK json_valid on the column) but we
 * defend against it because the cost is negligible and an exception here
 * would roll back an otherwise valid event apply.
 */
export function parseFieldHLCs(raw: string | null | undefined): FieldHLCMap {
  if (raw == null || raw === "") return {};
  try {
    const obj = JSON.parse(raw);
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj as FieldHLCMap;
  } catch {
    return {};
  }
}

export function serializeFieldHLCs(map: FieldHLCMap): string {
  return JSON.stringify(map);
}

/**
 * Read the stored HLC for a single field, synthesizing FIELD_HLC_INIT
 * when the field has never been written. Keeps callers from each
 * re-implementing the "missing means floor" rule.
 */
export function readFieldHLC(map: FieldHLCMap, field: string): HLC {
  const v = map[field];
  if (
    v == null ||
    typeof v.pms !== "number" ||
    typeof v.l !== "number" ||
    typeof v.did !== "string"
  ) {
    return { ...FIELD_HLC_INIT };
  }
  return v;
}

/**
 * Decide whether an incoming event should overwrite a field's value.
 *
 * Returns 'apply' iff eventHLC is strictly greater than the stored HLC.
 * Equal HLCs (same physical_ms + logical + device_id) only occur on an
 * idempotent replay of the same event, which is already filtered upstream
 * by event_log's INSERT OR IGNORE on event_id — so 'skip' on equality is
 * the safe choice (the value is identical anyway).
 */
export function compareFieldHLC(
  currentMap: FieldHLCMap,
  field: string,
  eventHLC: HLC,
): FieldDecision {
  const cur = readFieldHLC(currentMap, field);
  return compareHLC(eventHLC, cur) > 0 ? "apply" : "skip";
}
