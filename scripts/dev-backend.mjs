// `bun dev`: keep newly generated bill/tab links on the same testing backend
// as Expo Go, instead of sending a phone to the production site mid-test.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function setting(file, key) {
  try {
    const line = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .find((l) => l.trimStart().startsWith(key + "="));
    return line
      ?.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  } catch {
    return undefined;
  }
}

const env = { ...process.env };
const backendDir = resolve(root, "apps/backend");
const backendEnv = resolve(backendDir, ".env");
const candidate =
  env.KAATA_DEV_PUBLIC_URL ??
  env.EXPO_PUBLIC_BACKEND_URL ??
  setting(resolve(root, "apps/mobile/.env.local"), "EXPO_PUBLIC_BACKEND_URL") ??
  setting(resolve(root, "apps/mobile/.env"), "EXPO_PUBLIC_BACKEND_URL");
try {
  const url = new URL(candidate);
  // Never silently route a local test to a public backend. An explicit
  // KAATA_DEV_PUBLIC_URL also permits a developer's chosen HTTPS tunnel.
  const privateHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
    url.hostname,
  );
  if (
    (privateHost || env.KAATA_DEV_PUBLIC_URL) &&
    !url.username &&
    !url.password &&
    (url.protocol === "http:" || url.protocol === "https:")
  ) {
    for (const key of ["SHARE_LINK_BASE_URL", "PUBLIC_API_BASE_URL"]) {
      if (!env[key] && !setting(backendEnv, key)) env[key] = url.origin;
    }
    console.log(`Testing links: ${env.SHARE_LINK_BASE_URL ?? "backend .env override"}`);
  }
} catch {
  /* No local URL configured: keep the backend's existing defaults. */
}

const child = spawn("go", ["run", "./cmd/server"], { cwd: backendDir, env, stdio: "inherit" });
child.on("error", (err) => {
  console.error(`Could not start backend: ${err.message}`);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
