/**
 * Ad-hoc survey runner (#1231): pull the corpus, classify every chart, print
 * the per-chart table with reasons. The asserting entry point is
 * survey.test.ts — this script exists for corpus maintenance:
 *
 *   npx tsx lexicons/helm/test/survey/run-survey.ts
 *   npx tsx lexicons/helm/test/survey/run-survey.ts --write-expected
 *
 * `--write-expected` regenerates expected.txt from the actual results. Do
 * that only when a corpus change (new chart, version bump) is intended, and
 * review the diff — expected.txt is the regression surface.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatReasons,
  formatRow,
  parseCorpus,
  pullChart,
  surveyChart,
  valuesFileFor,
  type SurveyRow,
} from "./survey";

const surveyDir = import.meta.dirname;
const corpus = parseCorpus(readFileSync(join(surveyDir, "charts.txt"), "utf8"));

const rows: SurveyRow[] = [];
const failures: string[] = [];

for (const entry of corpus) {
  try {
    const chartDir = pullChart(entry);
    const row = surveyChart(entry.name, entry.version, chartDir, valuesFileFor(surveyDir, entry.name));
    rows.push(row);
    console.log(formatRow(row));
    console.log(`  why: ${formatReasons(row)}`);
  } catch (err) {
    failures.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`${entry.name} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} chart(s) failed — a chart that cannot render is a harness failure, not an omission.`);
  process.exit(1);
}

if (process.argv.includes("--write-expected")) {
  const lines = rows.map((r) => formatRow(r)).join("\n");
  writeFileSync(join(surveyDir, "expected.txt"), `${lines}\n`);
  console.log("\nwrote expected.txt");
}
