// Public export API. Each call gathers data, renders the artifact (CSV or
// PDF), writes it under <cache>/exports with a human filename, and then either
// opens the native share sheet or saves a copy into a folder the user picks
// (Android: SAF, i.e. real Downloads; iOS: Files). Errors throw — callers
// surface their own toast/inline copy. The document language is the app UI
// language at the moment of export (the artifact is the shopkeeper's own
// paper, unlike WhatsApp messages which have their separate share-language
// preference).
import { getAccountIdSync, getActiveVaultIdSyncMaybe } from "../db-tx";
import { getLocale } from "../i18n";
import {
  buildPersonStatements,
  buildVaultReports,
  exportFileName,
  saveExportFile,
  shareExportFile,
  writeExportFile,
  type SaveOutcome,
} from "./data";

export type { SaveOutcome } from "./data";

/**
 * The confirmation for a completed save, or null when there is nothing to
 * confirm. Shared by every export call site so the two screens can never
 * word the same outcome differently.
 */
export function savedMessage(
  t: (key: "export.saved" | "export.savedDownloads", vars: { name: string }) => string,
  isolate: (s: string) => string,
  outcome: ExportResult,
): string | null {
  if (!outcome || outcome.via === "share") return null;
  const name = isolate(outcome.name);
  return outcome.via === "downloads"
    ? t("export.savedDownloads", { name })
    : t("export.saved", { name });
}
import { buildPersonCurrenciesCsv, buildVaultCurrenciesCsv } from "./csv";
import { renderPersonCurrenciesPdf, renderVaultCurrenciesPdf } from "./pdf";

export type ExportFormat = "csv" | "pdf";
/** Where the finished file goes: the OS share sheet, or a folder on the phone. */
export type ExportDestination = "share" | "save";

/**
 * How a save was fulfilled — where the file went and under what name, so the
 * caller can word its confirmation — or null when sharing (the OS sheet is its
 * own feedback) and when the user backed out of the iOS destination picker.
 */
export type ExportResult = SaveOutcome | null;

/** Customer statements include all currencies in the current Kaata. */
export async function exportPersonStatement(
  personId: string,
  format: ExportFormat,
  destination: ExportDestination,
): Promise<ExportResult> {
  const now = Date.now();
  const vaultId = getActiveVaultIdSyncMaybe();
  const accountId = getAccountIdSync();
  if (!vaultId) throw new Error("export: no active Kaata");
  const assertCurrent = () => {
    if (getActiveVaultIdSyncMaybe() !== vaultId || getAccountIdSync() !== accountId)
      throw new Error("export: active Kaata changed");
  };
  const statements = await buildPersonStatements(personId, vaultId, getLocale(), now);
  assertCurrent();
  if (statements.length === 0) throw new Error("export: person not found");
  const fileName = exportFileName(statements[0].person.name, now, format);

  if (format === "csv") {
    const csv = buildPersonCurrenciesCsv(statements);
    if (destination === "save") return saveExportFile({ fileName, kind: "csv", contents: csv });
    const file = writeExportFile(fileName, csv);
    await shareExportFile(file.uri, "csv");
    return null;
  }

  const file = await renderPersonCurrenciesPdf(statements, fileName);
  assertCurrent();
  if (destination === "save") return saveExportFile({ fileName, kind: "pdf", source: file });
  await shareExportFile(file.uri, "pdf");
  return null;
}

/** Vault export takes the on-screen vault's id/name/currency explicitly —
 *  vault settings can be open for a non-active vault (?id= param), and the
 *  active-vault currency/name would silently describe the wrong book. */
export async function exportVaultReport(
  vault: { id: string; name: string; currency: string },
  format: ExportFormat,
  destination: ExportDestination,
): Promise<ExportResult> {
  const now = Date.now();
  const reports = await buildVaultReports(vault.id, vault.name, vault.currency, getLocale(), now);
  const fileName = exportFileName(vault.name, now, format);

  if (format === "csv") {
    const csv = buildVaultCurrenciesCsv(reports);
    if (destination === "save") return saveExportFile({ fileName, kind: "csv", contents: csv });
    const file = writeExportFile(fileName, csv);
    await shareExportFile(file.uri, "csv");
    return null;
  }

  const file = await renderVaultCurrenciesPdf(reports, fileName);
  if (destination === "save") return saveExportFile({ fileName, kind: "pdf", source: file });
  await shareExportFile(file.uri, "pdf");
  return null;
}
