import { readFileSync } from "node:fs";
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

const commands = [
  { name: "backend", command: "bun run dev:backend", prefixColor: "blue" },
  { name: "web", command: "bun run dev:web", prefixColor: "green" },
  { name: "mobile", command: "bun run dev:mobile", prefixColor: "magenta" },
].map((command) => ({ ...command, cwd: root, env }));
const { result } = concurrently(commands, {
  prefix: "name",
  killOthersOn: ["success", "failure"],
});

try {
  await result;
} catch {
  process.exitCode = 1;
}
