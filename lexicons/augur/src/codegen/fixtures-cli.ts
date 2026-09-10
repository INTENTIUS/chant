#!/usr/bin/env tsx
/**
 * Regenerate the two artifacts that are derived rather than authored, and that
 * a test then holds the rest of the tree to:
 *
 *   npm run fixtures --prefix lexicons/augur golden   # src/__fixtures__/golden-request.json
 *   npm run fixtures --prefix lexicons/augur tables   # the coverage tables, to stdout
 *
 * The golden request is what `../request.test.ts` compares against, and the
 * tables are what `docs/pages/coverage.mdx` carries and `../coverage-doc.test.ts`
 * checks. Neither is written by a test: a suite that regenerates its own
 * expectation cannot fail, and the point of a golden is that a change to the
 * coverage table or the wire shape arrives as a diff a reviewer reads.
 *
 * So the sequence for a deliberate change is: change the code, run this, read
 * the diff, commit it.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleRequestOptions } from "../__fixtures__/example-request";
import { buildEngineRequest, renderEngineRequest } from "../request";
import { coverageMarkdown } from "../coverage-doc";

const what = process.argv[2] ?? "golden";

if (what === "tables") {
  process.stdout.write(coverageMarkdown());
} else if (what === "golden") {
  const out =
    process.argv[3] ??
    join(dirname(dirname(fileURLToPath(import.meta.url))), "__fixtures__", "golden-request.json");
  const rendered = renderEngineRequest(buildEngineRequest(await exampleRequestOptions()));
  writeFileSync(out, rendered);
  console.error(`wrote ${rendered.length} bytes to ${out}`);
} else {
  console.error(`unknown fixture "${what}" — expected "golden" or "tables"`);
  process.exit(1);
}
