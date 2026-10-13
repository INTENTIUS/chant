/**
 * Re-record `recorded/` from a real Terragrunt run over `five-units/`:
 *
 *     PATH=<dir with terragrunt 1.1+ and tofu>:$PATH npx tsx lexicons/terraform/src/__fixtures__/terragrunt/record.ts
 *
 * It copies the fixture to a temporary directory, discovers the units, plans
 * and applies wave 1, then plans wave 2, and writes what Terragrunt printed
 * and wrote with the temporary directory's path taken out.
 *
 * `recorded/failed-plan-report.json` is not written here. It was recorded by
 * hand with Terragrunt 1.1.6 and OpenTofu 1.12.5, planning `live/dev/db`,
 * `live/dev/app` and `live/prod/app` in one run after giving `live/dev/db` a
 * `before_hook` that runs `false` on plan: db fails, app exits early because
 * db failed, and prod/app plans.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTerragruntExec, terragruntFindArgs, terragruntWaveArgs, terragruntWaves, parseTerragruntFind } from "../../terragrunt";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "recorded");
const tmp = mkdtempSync(join(tmpdir(), "chant-tg-record-"));
const dir = join(tmp, "repo");
cpSync(join(here, "five-units"), dir, { recursive: true });
const scrub = (s: string): string => s.split(tmp).join("<tmp>");
const save = (name: string, text: string): void => {
  mkdirSync(dirname(join(out, name)), { recursive: true });
  writeFileSync(join(out, name), scrub(text));
};

const version = await defaultTerragruntExec("terragrunt", ["--version"], { cwd: dir, env: {} });
save("version.txt", version.stdout);
const find = await defaultTerragruntExec("terragrunt", terragruntFindArgs(), { cwd: dir, env: {} });
if (find.code !== 0) throw new Error(find.stderr);
save("find.json", find.stdout);
const waves = terragruntWaves(parseTerragruntFind(find.stdout));
for (const [i, units] of waves.slice(0, 2).entries()) {
  const n = i + 1;
  const work = join(tmp, `wave-${n}`);
  const plan = terragruntWaveArgs({ units, command: "plan", outDir: join(work, "plans"), jsonOutDir: join(work, "json"), reportFile: join(work, "plan-report.json") });
  const p = await defaultTerragruntExec("terragrunt", plan, { cwd: dir, env: {} });
  if (p.code !== 0) throw new Error(p.stderr);
  save(`wave-${n}/plan-report.json`, readFileSync(join(work, "plan-report.json"), "utf8"));
  for (const u of units) save(`wave-${n}/json/${u}/tfplan.json`, readFileSync(join(work, "json", u, "tfplan.json"), "utf8"));
  if (n === 1) {
    const apply = terragruntWaveArgs({ units, command: "apply", outDir: join(work, "plans"), reportFile: join(work, "apply-report.json") });
    const a = await defaultTerragruntExec("terragrunt", apply, { cwd: dir, env: {} });
    if (a.code !== 0) throw new Error(a.stderr);
    save(`wave-${n}/apply-report.json`, readFileSync(join(work, "apply-report.json"), "utf8"));
  }
}
rmSync(tmp, { recursive: true, force: true });
console.log(`recorded ${out}`);
