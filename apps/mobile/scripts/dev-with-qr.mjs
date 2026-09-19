// apps/mobile/scripts/dev-with-qr.mjs
//
// Runs `expo start` and prints the Expo Go QR code even when stdout is not a
// terminal.
//
// Why this exists: the root `bun dev` runs backend, web and mobile through
// `concurrently`, which hands every child a PIPE for stdout instead of the
// real terminal. @expo/cli's `isInteractive()` is literally
// `!shouldReduceLogs() && !env.CI && process.stdout.isTTY`, and when it is
// false startAsync takes a branch that logs one `Waiting on <url>` line and
// never calls printDevServerInfoAsync — the function that draws the QR. So the
// QR did not get mangled by the prefixer, it was never printed. Running
// `expo start` on its own showed it; the moment it moved under `bun dev`,
// scanning turned into typing the URL in by hand.
//
// The fix is to draw it here, from Expo's OWN output. We pipe the child's
// stdout, echo every byte through untouched, and watch for the URL Expo
// reports. Taking the host and port from that line rather than re-deriving
// them means we cannot disagree with the server we are pointing at — which is
// a real risk on this machine, where a VPN adapter enumerates ahead of Wi-Fi,
// and also when a second Metro for the same project is already up on 8081.
//
// When stdout IS a terminal, this does nothing but hand the terminal straight
// to Expo, so running the script directly is byte-for-byte what `expo start`
// always did: Expo's own QR, its own sextant rendering, and the interactive
// keys. Those keys cannot work under `bun dev` regardless — concurrently owns
// stdin — so the QR is the part worth getting back.
//
// Everything is best-effort. Any failure leaves `expo start` untouched and you
// still have the URL as text, exactly as before this file existed.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const MOBILE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Gap between concurrently's "[mobile] " prefix and the code. The rendering
// is normal polarity — light modules print as white blocks — so the thin white
// border Expo draws IS the quiet zone; this indent does not add to it, it just
// keeps the prefix text far enough left that a camera cannot mistake it for
// part of the pattern.
const QR_INDENT = "    ";

// Expo's non-interactive banner is `Waiting on http://<host>:<port>`, wrapped
// in chalk's underline escapes. The second pattern is the safety net: any
// LAN-looking dev-server URL in the first lines of output will do, so an SDK
// that rewords the banner degrades to "still works" rather than "no QR".
const WAITING_ON = /Waiting on\s+?\[?[\d;]*m?(?<url>[a-z]+:\/\/[^\s]+)/i;
const ANY_LAN_URL = /(?<scheme>exps?|https?):\/\/(?<host>\d{1,3}(?:\.\d{1,3}){3}):(?<port>\d{2,5})/;

/**
 * Expo's half-block QR renderer (@expo/cli utils/qr.js createHalfblockOutput),
 * reproduced so the output is glyph-identical to what `expo start` draws.
 * Note the inversion: a SET module prints blank and a clear module prints as a
 * block, which is what makes it scan against a dark terminal background.
 */
function renderHalfblockQR(data) {
  const extent = Math.sqrt(data.byteLength) | 0;
  const FULL = "█";
  const LOWER = "▄";
  const UPPER = "▀";
  const BLANK = " ";
  let output = LOWER.repeat(extent + 2);
  for (let row = 0; row < extent; row += 2) {
    output += "\n" + FULL;
    for (let col = 0; col < extent; col++) {
      const value = (data[row * extent + col] << 1) | data[(row + 1) * extent + col];
      output += value === 0 ? FULL : value === 1 ? UPPER : value === 2 ? LOWER : BLANK;
    }
    output += FULL;
  }
  if (extent % 2 === 0) output += "\n" + UPPER.repeat(extent + 2);
  return output;
}

/**
 * The LAN address to advertise, resolved through `lan-network` — the exact
 * package @expo/cli's own getIpAddressAsync calls. Using anything else risks
 * disagreeing with the server: on a machine with a VPN, the tunnel adapter
 * enumerates ahead of Wi-Fi, so naively taking the first non-internal IPv4
 * would print a QR pointing down the tunnel.
 */
function lanHost() {
  try {
    const { lanNetworkSync } = require("lan-network");
    const address = lanNetworkSync()?.address;
    return address && address !== "127.0.0.1" ? address : null;
  } catch {
    return null;
  }
}

/**
 * `http://localhost:8090` -> `exp://192.168.0.188:8090`.
 *
 * The PORT is taken from Expo's own banner, because that is the part we cannot
 * safely guess: 8081 may be taken, and a second Metro for this same project
 * would answer a probe just as convincingly as the right one. The HOST usually
 * has to be substituted, because the non-interactive branch of startAsync logs
 * `getDevServerUrl()` with no hostType, which reports loopback — useless on a
 * phone, where it would mean the phone itself.
 */
function toExpoGoUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (!parsed.port) return null;
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname.startsWith("127.");
    const host = isLoopback ? lanHost() : parsed.hostname;
    return host ? `exp://${host}:${parsed.port}` : null;
  } catch {
    return null;
  }
}

function printQR(url) {
  let toQR;
  try {
    ({ toQR } = require("toqr"));
  } catch {
    // Ships as an @expo/cli dependency. If an upgrade drops it we lose the QR,
    // not the dev server.
    return;
  }
  let block;
  try {
    block = renderHalfblockQR(toQR(url));
  } catch {
    return;
  }
  const lines = [
    "",
    ...block.split("\n").map((line) => QR_INDENT + line),
    "",
    `${QR_INDENT}Scan with Expo Go  ${url}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// `node node_modules/expo/bin/cli start` rather than the `expo` shim: the shim
// is a .cmd on Windows, which spawn cannot exec without a shell, and putting a
// shell in the middle would mangle forwarded arguments.
const expoCli = require.resolve("expo/bin/cli");
const forwardedArgs = process.argv.slice(2);

// A real terminal goes straight to Expo: its own QR, its own interactive keys,
// nothing from us. Only the piped case needs help.
const passthrough = Boolean(process.stdout.isTTY);

const child = spawn(process.execPath, [expoCli, "start", ...forwardedArgs], {
  cwd: MOBILE_DIR,
  stdio: passthrough ? "inherit" : ["inherit", "pipe", "inherit"],
});

if (!passthrough && child.stdout) {
  let printed = false;
  let carry = "";
  child.stdout.on("data", (chunk) => {
    // Echo first and unmodified, so this wrapper can never cost a log line or
    // reorder output, whatever happens below.
    process.stdout.write(chunk);
    if (printed) return;
    carry += chunk.toString("utf8");
    const newlineAt = carry.lastIndexOf("\n");
    if (newlineAt === -1) {
      // Guard against a chatty no-newline stream growing unbounded.
      if (carry.length > 64_000) carry = carry.slice(-8_000);
      return;
    }
    const complete = carry.slice(0, newlineAt);
    carry = carry.slice(newlineAt + 1);
    for (const line of complete.split("\n")) {
      const banner = WAITING_ON.exec(line)?.groups?.url;
      const url = banner
        ? toExpoGoUrl(banner)
        : (() => {
            const loose = ANY_LAN_URL.exec(line)?.groups;
            return loose ? `exp://${loose.host}:${loose.port}` : null;
          })();
      if (url) {
        printed = true;
        printQR(url);
        return;
      }
    }
  });
}

// Forward interrupts so Ctrl+C in `bun dev` still stops Metro, and mirror the
// child's exit so concurrently's --kill-others behaves exactly as before.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error("[dev-with-qr] failed to start expo:", err.message);
  process.exit(1);
});
