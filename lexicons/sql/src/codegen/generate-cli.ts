#!/usr/bin/env tsx
import { generate, generatePostgres, writeGeneratedFiles } from "./generate";

// `npm run generate -- --force` reads the pinned servers even when the snapshots match the pins;
// `--major=18` limits the Postgres read to one major.
const force = process.argv.includes("--force");
const majors = process.argv
  .filter((a) => a.startsWith("--major="))
  .map((a) => Number.parseInt(a.slice("--major=".length), 10));
const result = await generate({ verbose: true, force });
const postgres = await generatePostgres({ force, ...(majors.length > 0 ? { majors } : {}) });
for (const note of postgres.notes) console.error(`[sql] ${note}`);
writeGeneratedFiles(result, undefined, postgres);
