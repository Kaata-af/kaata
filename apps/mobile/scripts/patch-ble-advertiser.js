#!/usr/bin/env node
/*
 * Idempotent postinstall patch for react-native-ble-advertiser@0.0.17.
 *
 * WHY: the lib's buildAdvertiseData() puts the 128-bit service UUID (18 bytes
 * on the wire) into the PRIMARY advertising PDU alongside manufacturer data and
 * the connectable Flags AD. That overflows the 31-byte legacy ADV_IND budget →
 * ADVERTISE_FAILED_DATA_TOO_LARGE → the phone never goes on air, so mesh peers
 * are never discoverable and BLE pairing silently fails. Kaata's scanner matches
 * peers on manufacturer data (null UUID filter, see lib/mesh/discovery-ble.ts),
 * so the on-wire service UUID is unused. We gate addServiceUuid() behind an
 * opt-in "includeServiceUuid" option (which Kaata never sets).
 *
 * This runs on every install (package.json "postinstall") so the fix survives
 * `npm install` and EAS builds, where node_modules is reinstalled from scratch.
 * patch-package would be the conventional tool, but it requires network at
 * generate-time; this script is self-contained and needs neither network nor a
 * new dependency. Idempotent: a no-op once patched or if the lib is absent.
 */
const fs = require("fs");
const path = require("path");

function findJava() {
  const rel = "android/src/main/java/com/vitorpamplona/bleadvertiser/BLEAdvertiserModule.java";
  // Strategy 1: resolve the installed package, derive the java path.
  try {
    const pkg = require.resolve("react-native-ble-advertiser/package.json", {
      paths: [process.cwd(), __dirname],
    });
    const p = path.join(path.dirname(pkg), rel);
    if (fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  // Strategy 2: cwd-relative (postinstall cwd is apps/mobile).
  const p2 = path.join(process.cwd(), "node_modules/react-native-ble-advertiser", rel);
  if (fs.existsSync(p2)) return p2;
  // Strategy 3: relative to this script (apps/mobile/scripts → ../node_modules).
  const p3 = path.join(__dirname, "..", "node_modules/react-native-ble-advertiser", rel);
  if (fs.existsSync(p3)) return p3;
  return null;
}

const ORIGINAL =
  "        dataBuilder.addManufacturerData(companyId, payload);\n" +
  "        dataBuilder.addServiceUuid(uuid);\n" +
  "        return dataBuilder.build();";

const PATCHED =
  "        dataBuilder.addManufacturerData(companyId, payload);\n" +
  "        // kaata patch: a 128-bit service UUID is 18 bytes on the wire; combined\n" +
  "        // with manufacturer data + the connectable Flags AD it overflows the\n" +
  "        // 31-byte legacy ADV_IND budget -> ADVERTISE_FAILED_DATA_TOO_LARGE.\n" +
  "        // Kaata's scanner matches on manufacturer data (null UUID filter), so\n" +
  "        // the on-wire service UUID is unused. Only include it when explicitly\n" +
  '        // requested via the "includeServiceUuid" option (default: omitted).\n' +
  '        if (options != null && options.hasKey("includeServiceUuid")\n' +
  '                && options.getBoolean("includeServiceUuid")) {\n' +
  "            dataBuilder.addServiceUuid(uuid);\n" +
  "        }\n" +
  "        return dataBuilder.build();";

const file = findJava();
if (!file) {
  console.log("[patch-ble-advertiser] react-native-ble-advertiser not found; skipping (ok)");
  process.exit(0);
}

let src = fs.readFileSync(file, "utf8");
if (src.includes('hasKey("includeServiceUuid")')) {
  console.log("[patch-ble-advertiser] already patched; skipping");
  process.exit(0);
}
if (!src.includes(ORIGINAL)) {
  console.warn(
    "[patch-ble-advertiser] WARNING: expected code not found (lib changed?). NOT patched — " +
      "BLE advertising may overflow the 31-byte budget and fail silently.",
  );
  process.exit(0);
}
fs.writeFileSync(file, src.replace(ORIGINAL, PATCHED));
console.log("[patch-ble-advertiser] patched addServiceUuid 31-byte overflow ✓");
