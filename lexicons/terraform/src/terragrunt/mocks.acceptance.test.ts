/**
 * Mock outputs in Terragrunt waves (#3416), against a real `terragrunt` 1.1+
 * and `tofu`, on the five-unit fixture: every unit is new, so wave 1 holds
 * new upstreams and wave 2 their new dependents. Wave 2 is refused until
 * wave 1 applied, and its plan then holds the real upstream values. A
 * provisional plan of wave 2 made before that reads the mocks, is marked,
 * and never applies.
 *
 * Skipped, with the reason in the title, when `terragrunt` or `tofu` is not
 * on PATH. Release binaries: https://github.com/gruntwork-io/terragrunt/releases.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { composeChangeSet } from "@intentius/chant/change-set";
import { groupChangeSet } from "@intentius/chant/plan-summary";
import { applyTerragruntWave, discoverTerragruntUnits, planTerragruntWave, TerragruntMockRefusal, terragruntMockWarnings, terragruntWaves } from "./index";

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
const tmp = mkdtempSync(join(tmpdir(), "chant-tg-mocks-accept-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The `upstream` input each unit's `terraform_data` plans, from the wave's change set. */
function upstreamInputs(parts: Parameters<typeof composeChangeSet>[0]): Record<string, unknown> {
  const doc = composeChangeSet(parts);
  return Object.fromEntries(
    doc.entries.map((e) => [e.member, (e.attributes.find((a) => a.path === "input")?.after as { upstream?: unknown } | undefined)?.upstream]),
  );
}

describe.skipIf(skipReason !== "")(`mock outputs in Terragrunt waves against a real terragrunt${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  const dir = join(tmp, "repo");
  cpSync(fixture, dir, { recursive: true });

  it(
    "refuses wave 2 until wave 1 applied, then plans it on the real upstream values",
    async () => {
      const { units } = await discoverTerragruntUnits({ dir, binary: "tofu" });
      const [wave1, wave2] = terragruntWaves(units);
      expect(wave1).toEqual(["live/dev/vpc", "live/prod/vpc"]);
      expect(wave2).toEqual(["live/dev/db", "live/prod/app"]);

      // Before wave 1 applied: refused, naming each upstream, and nothing planned.
      const refused = await planTerragruntWave({ dir, units: wave2!, workDir: join(tmp, "w2"), binary: "tofu" }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TerragruntMockRefusal);
      expect((refused as TerragruntMockRefusal).reads.map((r) => [r.unit, r.upstream, r.reason])).toEqual([
        ["live/dev/db", "live/dev/vpc", "no-outputs"],
        ["live/prod/app", "live/prod/vpc", "no-outputs"],
      ]);
      expect((refused as Error).message).toMatch(/Apply live\/dev\/vpc, live\/prod\/vpc first/);
      expect(existsSync(join(tmp, "w2", "plans"))).toBe(false);

      // The PR-time preview of the same wave reads the mocks, says so, and never applies.
      const preview = await planTerragruntWave({ dir, units: wave2!, workDir: join(tmp, "w2-preview"), binary: "tofu", provisional: true });
      expect(preview.code, preview.log).toBe(0);
      expect(preview.parts.map((p) => [p.member.member, p.member.status, p.member.provisional])).toEqual([
        ["live/dev/db", "planned", true],
        ["live/prod/app", "planned", true],
      ]);
      expect(upstreamInputs(preview.parts)).toEqual({ "live/dev/db": ["mock"], "live/prod/app": ["mock"] });
      // Terragrunt's own warning, which the after-the-fact check reads, names the same units.
      expect(terragruntMockWarnings(preview.log, [dir, realpathSync(dir)])).toEqual([
        { unit: "live/dev/db", upstream: "live/dev/vpc" },
        { unit: "live/prod/app", upstream: "live/prod/vpc" },
      ]);
      expect(groupChangeSet(composeChangeSet(preview.parts)).groups.every((g) => g.provisional === true)).toBe(true);
      await expect(applyTerragruntWave({ dir, units: wave2!, workDir: join(tmp, "w2-preview"), binary: "tofu" })).rejects.toThrow(/provisional/);
      expect(existsSync(join(dir, ".state/live/dev/db/terraform.tfstate"))).toBe(false);

      // Wave 1 plans (its units read nothing) and applies.
      const plan1 = await planTerragruntWave({ dir, units: wave1!, workDir: join(tmp, "w1"), binary: "tofu" });
      expect(plan1.code, plan1.log).toBe(0);
      const apply1 = await applyTerragruntWave({ dir, units: wave1!, workDir: join(tmp, "w1"), binary: "tofu" });
      expect(apply1.code, apply1.log).toBe(0);

      // Now wave 2 plans, and its plan holds the real upstream values.
      const plan2 = await planTerragruntWave({ dir, units: wave2!, workDir: join(tmp, "w2"), binary: "tofu" });
      expect(plan2.code, plan2.log).toBe(0);
      expect(plan2.provisional).toBe(false);
      expect(plan2.parts.map((p) => [p.member.member, p.member.status, p.member.provisional])).toEqual([
        ["live/dev/db", "planned", undefined],
        ["live/prod/app", "planned", undefined],
      ]);
      expect(upstreamInputs(plan2.parts)).toEqual({ "live/dev/db": ["live-dev-vpc-id"], "live/prod/app": ["live-prod-vpc-id"] });
      expect(plan2.log).not.toMatch(/mock outputs provided/);
      const apply2 = await applyTerragruntWave({ dir, units: wave2!, workDir: join(tmp, "w2"), binary: "tofu" });
      expect(apply2.code, apply2.log).toBe(0);
    },
    180_000,
  );
});
