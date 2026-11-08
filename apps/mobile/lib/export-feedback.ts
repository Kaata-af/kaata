import { ExportScopeError } from "./export/options";
import { tExport } from "./export-copy";

/** Do not expose backend or file-system error text to the recipient-facing UI. */
export function exportFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof ExportScopeError && error.code === "beforeSharedOpening")
    return tExport("beforeSharedOpening", { all: tExport("all"), detailed: tExport("detailed") });
  return fallback;
}
