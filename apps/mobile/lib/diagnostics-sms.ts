// Only structured App health fields enter the carrier-SMS draft. In particular,
// error messages/continuations, account IDs, URLs, and ledger rows stay out.
const SMS_SEPTETS = 450;
const SYNC_ERRORS = new Set([
  "none",
  "unknown",
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "NetworkError",
  "TimeoutError",
  "ApiError",
  "SessionExpiredError",
  "PermissionRejectedError",
  "SyncTimeoutError",
  "VaultNotRegisteredError",
  "SyncTransientError",
]);
const PERSON_ERRORS = new Set([
  "signing_unavailable",
  "storage_full",
  "storage_busy",
  "storage_constraint",
  "storage_io",
  "schema",
  "identity_not_ready",
  "unknown",
]);
const PERSON_STAGES = new Set(["vault_check", "create_person", "open_person"]);
const TIME = "(?:never|[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})";
const LABELS = [
  "App (native)",
  "App (JS bundle)",
  "Platform",
  "Install",
  "Active kaata",
  "Schema",
  "Sync",
  "Unsent events",
  "Last sync error",
  "Device key",
  "Membership proof",
  "Last contact save error",
  "Recent exits",
] as const;

function version(raw: string | undefined): string {
  const match = raw?.match(/^(\S+) \(build ([^()]+)\)$/);
  const code = match?.[1] ?? "?";
  const build = match?.[2] ?? "?";
  const safeCode =
    code.length <= 32 && /^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:[-+][A-Za-z0-9.-]+)*$/.test(code)
      ? code
      : "?";
  const safeBuild = build.length <= 12 && /^\d+(?:\.\d+)*$/.test(build) ? build : "?";
  return `${safeCode} b${safeBuild}`;
}

function keyStatus(raw: string | undefined): string | null {
  if (!raw) return null;
  const state = raw.match(
    /^(ready|NOT READY)(?: \((read_failed|write_failed|in_transaction|missing)\))?(, no mirror)?;/,
  );
  if (!state) return "Key:?";
  const rotations = raw.match(/; (?:never rotated|rotated (\d{1,6})x(?:,|$))/);
  const failures = raw.match(/; (\d{1,6}) consecutive read failures(?:;|$)/);
  let result = `Key:${state[1] === "ready" ? "ready" : "NOT READY"}`;
  if (state[2]) result += `/${state[2]}`;
  if (state[3]) result += " no-mirror";
  if (rotations) result += ` rot=${rotations[1] ?? "0"}`;
  if (failures) result += ` read=${failures[1]}`;
  if (/; pending (?:re-register|re-bind)(?:\+(?:re-register|re-bind))?$/.test(raw))
    result += " pending";
  return result;
}

/** At most three concatenated GSM-7 messages (450 single-septet characters).
 * Output is reconstructed from fixed grammars, not sliced from the full report:
 * unsupported text becomes `?`, and the complete valid install UUID and version
 * fields always precede optional details. No GSM extension-table characters are
 * emitted, so string length is also the exact septet count. */
export function compactDiagnosticsForSms(fullReport: string): string {
  const fields = new Map<string, string>();
  let exit: string | null = null;
  const lines = fullReport.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Continuations (including full sync errors) must never become fields.
    if (!line || /^\s/.test(line)) continue;
    for (const label of LABELS) {
      const prefix = `${label}: `;
      if (line.startsWith(prefix) && !fields.has(label))
        fields.set(label, line.slice(prefix.length));
    }
    if (line === "Recent exits (newest first):" && exit === null) {
      const match = lines[i + 1]?.match(
        /^  (\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (LOW_MEMORY|JAVA_CRASH|NATIVE_CRASH|ANR|SIGNALED|EXCESSIVE_RESOURCE|USER_REQUESTED|DEPENDENCY_DIED|OTHER_\d{1,3}) rss=(?:\d+(?:\.\d+)?MB|—) imp=\d{1,4}$/,
      );
      if (match) exit = `Exit:${match[1]} ${match[2]}`;
    }
  }

  const platform = fields
    .get("Platform")
    ?.match(/^(android|ios|web|windows|macos) ([0-9.]{1,16})$/);
  const install = fields.get("Install");
  const validInstall = install?.match(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  const kaata = fields.get("Active kaata");
  const schema = fields.get("Schema")?.match(/^(\d{1,6})(?:_[a-z0-9_]+)? \((\d{1,9}) applied\)$/i);
  const sync = fields
    .get("Sync")
    ?.match(new RegExp(`^push=(${TIME}) pull=(${TIME}) seq=(\\d{1,12})$`));
  const events = fields.get("Unsent events")?.match(/^(\d{1,9})  ·  Rejected: (\d{1,9})$/);
  const result = [
    "Kaata App health",
    `Native:${version(fields.get("App (native)"))}`,
    `JS:${version(fields.get("App (JS bundle)"))}`,
    `Platform:${platform ? `${platform[1]} ${platform[2]}` : "?"}`,
    `Install:${validInstall ? install : "?"}`,
    `Kaata:${kaata && /^(?:[A-Za-z0-9-]{1,8}|none)$/.test(kaata) ? kaata : "?"}`,
    `Schema:${schema ? `${schema[1]}/${schema[2]}` : "?"}`,
    `Sync:${sync ? `p=${sync[1]} q=${sync[2]} seq=${sync[3]}` : "?"}`,
    `Events:${events ? `unsent=${events[1]} rejected=${events[2]}` : "?"}`,
  ];

  const syncError = fields.get("Last sync error");
  const errorName = syncError?.split(" @ ", 1)[0];
  const personError = fields
    .get("Last contact save error")
    ?.match(/^(\w+) \((\w+)\) @ \d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const proof = fields
    .get("Membership proof")
    ?.match(
      /(?:^| )currentMember=(yes|no|unknown) currentDevice=(yes|no|unknown|not ready)(?: |$)/,
    );
  const optional = [
    syncError ? `SyncErr:${errorName && SYNC_ERRORS.has(errorName) ? errorName : "other"}` : null,
    keyStatus(fields.get("Device key")),
    proof ? `Proof:m=${proof[1]} d=${proof[2].replace(" ", "-")}` : null,
    personError && PERSON_ERRORS.has(personError[1]) && PERSON_STAGES.has(personError[2])
      ? `PersonErr:${personError[1]}/${personError[2]}`
      : null,
    exit ?? (fields.get("Recent exits") === "none recorded" ? "Exit:none" : null),
  ];
  let text = result.join("\n");
  for (const line of optional) {
    if (line && text.length + 1 + line.length <= SMS_SEPTETS) text += `\n${line}`;
  }
  return text;
}
