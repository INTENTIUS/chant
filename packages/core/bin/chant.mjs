#!/usr/bin/env node
// Cross-runtime CLI wrapper. Detects Bun or Node and invokes main.ts accordingly.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const binDir = dirname(fileURLToPath(import.meta.url));
const mainTs = resolve(binDir, "../src/cli/main.ts");

// If already running under Bun, just import directly
if (typeof globalThis.Bun !== "undefined") {
  await import(mainTs);
} else {
  // Under Node.js — need tsx to run .ts files
  try {
    execFileSync("npx", ["tsx", mainTs, ...process.argv.slice(2)], { stdio: "inherit" });
  } catch (e) {
    if (e && typeof e === "object" && "status" in e && typeof e.status === "number") {
      process.exit(e.status);
    }
    console.error("chant requires Bun or tsx to run. Install with: npm i -g tsx");
    process.exit(1);
  }
}
