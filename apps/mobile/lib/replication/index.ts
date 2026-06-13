// Public surface of the Sync v2 replication engine (M1).
//
// planner.ts   — pure vector/range math (self-tested under bun)
// store.ts     — SQLite queries backing the planner
// server-vector.ts — advisory server-channel adapter (convergence checks)
//
// M3 (LAN) and M4 (BLE) add transport drivers that consume the same planner
// as the source of truth; the server channel keeps its outbox/cursor model.

export {
  computeContiguous,
  diffVectors,
  planRangesToSend,
  provableFrontier,
  splitIntoBatches,
  toConservativeVector,
} from "./planner";
export type { PeerVector, PeerVectorEntry, SeqRange, Vector } from "./planner";

export { localFrontierReport } from "./store";
export type { FrontierReport } from "./store";

export { checkConvergence, fetchServerVector } from "./server-vector";
export type { ConvergenceReport, ServerVectorResponse } from "./server-vector";
