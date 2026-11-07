import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("web production packages each shared mobile domain module", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const domain = read("../src/lib/mobile-domain.ts");
  const copyInputs = read("../Dockerfile").replace(/\\\r?\n/g, " ");
  const allowed = new Set(read("../Dockerfile.dockerignore").split(/\r?\n/));
  const copies = new Set(
    copyInputs
      .split(/\r?\n/)
      .filter((line) => line.startsWith("COPY "))
      .flatMap((line) => line.split(/\s+/)),
  );
  const modules = [...domain.matchAll(/from "\.\.\/\.\.\/\.\.\/mobile\/lib\/([^"\n]+)"/g)];
  assert.ok(modules.length, "Expected portable mobile imports");
  for (const [, module] of modules) {
    const path = `apps/mobile/lib/${module}.ts`;
    assert.ok(allowed.has(`!${path}`), `${path} must enter the Docker build context`);
    assert.ok(copies.has(path), `${path} must be copied into the web builder`);
  }
});
