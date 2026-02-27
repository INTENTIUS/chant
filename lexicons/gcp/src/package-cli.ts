#!/usr/bin/env bun
import { gcpPlugin } from "./plugin";

async function main() {
  const verbose = process.argv.includes("--verbose") || !process.argv.includes("--quiet");
  const force = process.argv.includes("--force");
  await gcpPlugin.package!({ verbose, force });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
