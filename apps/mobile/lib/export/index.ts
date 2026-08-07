// Public export API. Each call gathers data, renders the artifact (CSV or
// PDF), writes it under <cache>/exports with a human filename, and then either
// opens the native share sheet or saves a copy into a folder the user picks
// (Android: SAF, i.e. real Downloads; iOS: Files). Errors throw — callers
// surface their own toast/inline copy. The document language is the app UI
// language at the moment of export (the artifact is the shopkeeper's own
// paper, unlike WhatsApp messages which have their separate share-language
// preference).
import { getCurrentCurrencyCode, getCurrentCurrencySymbol } from "../currency";
import { getLocale } from "../i18n";
import {
  buildPersonStatement,
  buildVaultReport,
  exportFileName,
  saveExportFile,
  shareExportFile,
  writeExportFile,
} from "./data";
import { buildPersonCsv, buildVaultCsv } from "./csv";
import { renderPersonStatementPdf, renderVaultReportPdf } from "./pdf";

export type ExportFormat = "csv" | "pdf";
/** Where the finished file goes: the OS share sheet, or a folder on the phone. */
export type ExportDestination = "share" | "save";

/**
 * Resolves to the file name the OS actually created when saving to the phone
 * (providers dedupe, so it may differ from the requested one) — and to null
 * when sharing, or when the user backed out of the folder picker. Callers use
 * a non-null result as "confirm the save to the user".
 */
export type ExportResult = string | null;

/** Person statements always run on the active vault (person screens only
 *  exist there), so the active currency getters are correct here. */
export async function exportPersonStatement(
  personId: string,
  format: ExportFormat,
  destination: ExportDestination,
): Promise<ExportResult> {
  const now = Date.now();
  const statement = await buildPersonStatement(
    personId,
    getLocale(),
    getCurrentCurrencyCode(),
    getCurrentCurrencySymbol(),
    now,
  );
  if (!statement) throw new Error("export: person not found");
  const fileName = exportFileName(statement.person.name, now, format);

  if (format === "csv") {
    const csv = buildPersonCsv(statement);
    if (destination === "save") return saveExportFile({ fileName, kind: "csv", contents: csv });
    const file = writeExportFile(fileName, csv);
    await shareExportFile(file.uri, "csv");
    return null;
  }

  const file = await renderPersonStatementPdf(statement, fileName);
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
  const report = await buildVaultReport(vault.id, vault.name, vault.currency, getLocale(), now);
  const fileName = exportFileName(vault.name, now, format);

  if (format === "csv") {
    const csv = buildVaultCsv(report);
    if (destination === "save") return saveExportFile({ fileName, kind: "csv", contents: csv });
    const file = writeExportFile(fileName, csv);
    await shareExportFile(file.uri, "csv");
    return null;
  }

  const file = await renderVaultReportPdf(report, fileName);
  if (destination === "save") return saveExportFile({ fileName, kind: "pdf", source: file });
  await shareExportFile(file.uri, "pdf");
  return null;
}
