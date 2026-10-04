/**
 * Terragrunt units as roots (#3414), against a real `terragrunt` 1.1+ and
 * `tofu`: on the five-unit fixture (implicit stacks), discovery matches
 * `terragrunt find`, each wave plans and applies exactly its units, and the
 * run report's per-unit results reach the change set.
 *
 * The fixture's units hold `terraform_data` only, with local state under the
 * copied fixture, so no provider is downloaded and no cloud is called.
 *
 * Skipped, with the reason in the title, when `terragrunt` or `tofu` is not
 * on PATH. Release binaries: https://github.com/gruntwork-io/terragrunt/releases.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { composeChangeSet } from "@intentius/chant/change-set";
import {
  applyTerragruntWave,
  checkTerragruntVersion,
  defaultTerragruntExec,
  discoverTerragruntUnits,
  planTerragruntWave,
  terragruntWaves,
} from "./index";

function onPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skipReason = !onPath("terragrunt") ? "no terragrunt on PATH" : !onPath("tofu") ? "no tofu on PATH" : "";
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/terragrunt/five-units");
const tmp = mkdtempSync(join(tmpdir(), "chant-tg-accept-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Units with state, by walking `.state/` as the fixture's root.hcl lays it out. */
function unitsWithState(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(dir, ".state", rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && e.name === "terraform.tfstate") out.push(rel);
      else if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk("");
  return out.sort();
}

describe.skipIf(skipReason !== "")(`Terragrunt units against a real terragrunt${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  const dir = join(tmp, "repo");
  cpSync(fixture, dir, { recursive: true });

  it("runs on 1.1 or later", async () => {
    expect(await checkTerragruntVersion({ dir })).toMatch(/terragrunt version v\d/);
  });

  it("discovers what terragrunt find lists, less the catalog template", async () => {
    const plain = await defaultTerragruntExec("terragrunt", ["find", "--json", "--no-color"], { cwd: dir, env: {} });
    const listed = (JSON.parse(plain.stdout) as Array<{ path: string }>).map((u) => u.path).sort();
    expect(listed).toContain("catalog/units/thing");
    const { units, warnings } = await discoverTerragruntUnits({ dir, binary: "tofu" });
    expect(units.map((u) => u.path).sort()).toEqual(listed.filter((p) => !p.startsWith("catalog/")));
    expect(warnings).toEqual([]);
  });

  it(
    "plans and applies each wave's units and no others, and the run report reaches the change set",
    async () => {
      const { units } = await discoverTerragruntUnits({ dir, binary: "tofu" });
      const waves = terragruntWaves(units);
      expect(waves).toEqual([["live/dev/vpc", "live/prod/vpc"], ["live/dev/db", "live/prod/app"], ["live/dev/app"]]);
      const applied: string[] = [];
      for (const [i, wave] of waves.entries()) {
        const workDir = join(tmp, `wave-${i + 1}`);
        const plan = await planTerragruntWave({ dir, units: wave, workDir, binary: "tofu", parallelism: 4 });
        expect(plan.code, plan.log).toBe(0);
        expect(plan.results.map((r) => [r.unit, r.result])).toEqual(wave.map((u) => [u, "succeeded"]));
        expect(readdirSync(join(workDir, "json"), { recursive: true }).filter((f) => String(f).endsWith("tfplan.json")).map((f) => dirname(String(f))).sort()).toEqual(wave);

        const doc = composeChangeSet(plan.parts);
        expect(doc.members.map((m) => [m.member, m.status])).toEqual(wave.map((u) => [u, "planned"]));
        expect(doc.summary.actions.create).toBe(wave.length);
        // Each wave planned after its upstream applied, so no input carries a mock.
        expect(JSON.stringify(doc.entries)).not.toContain('"mock"');

        expect(unitsWithState(dir)).toEqual([...applied].sort());
        const apply = await applyTerragruntWave({ dir, units: wave, workDir, binary: "tofu" });
        expect(apply.code, apply.log).toBe(0);
        expect(apply.results.map((r) => [r.unit, r.result])).toEqual(wave.map((u) => [u, "succeeded"]));
        applied.push(...wave);
        expect(unitsWithState(dir)).toEqual([...applied].sort());
      }
    },
    120_000,
  );

  it("keeps a wave to its units when .terragrunt-filters selects more", async () => {
    const other = join(tmp, "with-filters-file");
    cpSync(fixture, other, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(other, ".terragrunt-filters"), "./live/prod/**\n");
    const { units } = await discoverTerragruntUnits({ dir: other });
    expect(units.map((u) => u.path).sort()).toEqual(["live/prod/app", "live/prod/vpc"]);
    // Terragrunt unions the file's filters with the command line's, so a wave run must not read it.
    const plan = await planTerragruntWave({ dir: other, units: ["live/dev/vpc"], workDir: join(tmp, "filters-wave") });
    expect(plan.code, plan.log).toBe(0);
    expect(plan.results.map((r) => [r.unit, r.result])).toEqual([["live/dev/vpc", "succeeded"]]);
    expect(readdirSync(join(tmp, "filters-wave", "json"), { recursive: true }).filter((f) => String(f).endsWith("tfplan.json"))).toEqual([
      join("live", "dev", "vpc", "tfplan.json"),
    ]);
  });
});
