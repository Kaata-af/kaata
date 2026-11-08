import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { concurrently } from "concurrently";

const root = fileURLToPath(new URL("../", import.meta.url));
// Load the optional local profile here so it reaches all three dev processes
// and stays out of production builds run from this checkout.
let env = {};
try {
  env = parseEnv(readFileSync(new URL("../.env.development.local", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// Only the explicit local profile can select a test witness for Metro. Keep
// the test key scoped to the same backend origin the bundle will call.
const mobileEnv = {
  ...env,
  MESH_SIGNING_PRIVKEY_PRIMARY: "",
  EXPO_PUBLIC_DEV_WITNESS_ORIGIN: "",
  EXPO_PUBLIC_DEV_WITNESS_PUBKEY: "",
  EXPO_PUBLIC_DEV_WITNESS_ROTATION_PUBKEY: "",
};
const publicKeyPattern = /^[A-Za-z0-9+/]{43}=$/;
if (
  env.KAATA_ENV === "development" &&
  publicKeyPattern.test(env.MESH_SIGNING_PUBKEY_PRIMARY ?? "")
) {
  try {
    const backend = new URL(env.EXPO_PUBLIC_BACKEND_URL);
    const host = backend.hostname;
    const local =
      host === "localhost" ||
      host === "[::1]" ||
      (isIP(host) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
    const trustedTunnel =
      !local &&
      backend.protocol === "https:" &&
      env.KAATA_DEV_PUBLIC_URL &&
      new URL(env.KAATA_DEV_PUBLIC_URL).origin === backend.origin;
    if (
      (backend.protocol === "http:" || backend.protocol === "https:") &&
      !backend.username &&
      !backend.password &&
      (local || trustedTunnel)
    ) {
      mobileEnv.EXPO_PUBLIC_DEV_WITNESS_ORIGIN = backend.origin;
      mobileEnv.EXPO_PUBLIC_DEV_WITNESS_PUBKEY = env.MESH_SIGNING_PUBKEY_PRIMARY;
      if (publicKeyPattern.test(env.MESH_SIGNING_PUBKEY_ROTATION ?? "")) {
        mobileEnv.EXPO_PUBLIC_DEV_WITNESS_ROTATION_PUBKEY = env.MESH_SIGNING_PUBKEY_ROTATION;
      }
    }
  } catch {
    // No valid local backend in this profile. Use ordinary pinning.
  }
}

const commands = [
  { name: "backend", command: "bun run dev:backend", prefixColor: "blue" },
  { name: "web", command: "bun run dev:web", prefixColor: "green" },
  { name: "mobile", command: "bun run dev:mobile", prefixColor: "magenta" },
].map((command) => ({ ...command, cwd: root, env: command.name === "mobile" ? mobileEnv : env }));
const { result } = concurrently(commands, {
  prefix: "name",
  killOthersOn: ["success", "failure"],
});

try {
  await result;
} catch {
  process.exitCode = 1;
}
