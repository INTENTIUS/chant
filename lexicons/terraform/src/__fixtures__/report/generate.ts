/**
 * Regenerate the `chant terraform report` fixture behold renders (#4439):
 *
 *     npx tsx lexicons/terraform/src/__fixtures__/report/generate.ts
 *
 * It reads `plan.show.json` (a three-estate composed plan: network, app and
 * edge, with app reading network and edge reading app) and `applied.show.json`
 * (the plan made after the apply), runs `terraformReport` for both stages, and
 * writes `<stage>/report.json` and `<stage>/change-set.json` beside them.
 * `report.test.ts` runs `generateReportFixture` and compares it with the
 * files, so a change to the writer shows as a diff here.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { terraformReport, writeReport, type ReportStage, type ReportStore } from "../../report";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_RUN = { project: "forgejo:3000/admin/demo-terragrunt", commit: "4439c0ffee", job_url: "http://forgejo:3000/admin/demo-terragrunt/actions/runs/1", pull_request: "1" };
export const FIXTURE_ESTATES = { network: "demo-network", app: "demo-app", edge: "demo-edge" };
const FINISHED: Record<ReportStage, string> = { "tf-plan": "2026-10-25T10:00:00Z", "tf-apply": "2026-10-25T10:05:00Z" };

const readJson = (name: string): unknown => JSON.parse(readFileSync(join(here, name), "utf8"));

/** The fixture's output files by path under this directory: `<stage>/report.json` and `<stage>/change-set.json`. */
export async function generateReportFixture(): Promise<Record<string, string>> {
  const plan = readJson("plan.show.json");
  const applied = readJson("applied.show.json");
  const files: Record<string, string> = {};
  const store: ReportStore = {
    async read() {
      return undefined;
    },
    async put(key, body) {
      const m = /\/(tf-plan|tf-apply)\/(report|change-set)\.json$/.exec(key);
      if (m) files[`${m[1]}/${m[2]}.json`] = body;
    },
  };
  for (const stage of ["tf-plan", "tf-apply"] as const) {
    await writeReport(store, terraformReport({
      stage,
      plan,
      ...(stage === "tf-apply" ? { applied } : {}),
      run: FIXTURE_RUN,
      binary: "choudoufu",
      rootDir: "estates",
      estates: FIXTURE_ESTATES,
      finished: FINISHED[stage],
    }));
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await generateReportFixture();
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(here, name)), { recursive: true });
    writeFileSync(join(here, name), body);
  }
  console.log(`wrote ${Object.keys(files).join(", ")}`);
}
