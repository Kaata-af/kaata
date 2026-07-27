// Public export API. Each call gathers data, renders the artifact (CSV or
// PDF), writes it under <cache>/exports with a human filename, and opens the
// native share sheet. Errors throw — callers surface their own toast/inline
// copy. The document language is the app UI language at the moment of export
// (the artifact is the shopkeeper's own paper, unlike WhatsApp messages which
// have their separate share-language preference).
import { getCurrentCurrencyCode, getCurrentCurrencySymbol } from "../currency";
import { getLocale } from "../i18n";
import {
  buildPersonStatement,
  buildVaultReport,
  currencySymbolFor,
  exportFileName,
  shareExportFile,
  writeExportFile,
} from "./data";
import { buildPersonCsv, buildVaultCsv } from "./csv";
import { renderPersonStatementPdf, renderVaultReportPdf } from "./pdf";

export type ExportFormat = "csv" | "pdf";

/** Person statements always run on the active vault (person screens only
 *  exist there), so the active currency getters are correct here. */
export async function exportPersonStatement(personId: string, format: ExportFormat): Promise<void> {
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
    const file = writeExportFile(fileName, buildPersonCsv(statement));
    await shareExportFile(file.uri, "csv");
  } else {
    const file = await renderPersonStatementPdf(statement, fileName);
    await shareExportFile(file.uri, "pdf");
  }
}

/** Vault export takes the on-screen vault's id/name/currency explicitly —
 *  vault settings can be open for a non-active vault (?id= param), and the
 *  active-vault currency/name would silently describe the wrong book. */
export async function exportVaultReport(
  vault: { id: string; name: string; currency: string },
  format: ExportFormat,
): Promise<void> {
  const now = Date.now();
  const report = await buildVaultReport(vault.id, vault.name, vault.currency, getLocale(), now);
  const fileName = exportFileName(vault.name, now, format);
  if (format === "csv") {
    const file = writeExportFile(fileName, buildVaultCsv(report));
    await shareExportFile(file.uri, "csv");
  } else {
    const file = await renderVaultReportPdf(report, fileName);
    await shareExportFile(file.uri, "pdf");
  }
}

export { currencySymbolFor };
