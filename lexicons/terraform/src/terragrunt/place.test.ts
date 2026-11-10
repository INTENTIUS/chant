/**
 * chant#4910: where a Terragrunt unit's binary runs, as Terragrunt prepares
 * it. The fake Terragrunt runs the `TG_TF_PATH` wrapper itself, in a working
 * directory of its own and with an input as a `TF_VAR_`, as Terragrunt does;
 * the binary the wrapper then runs is `true`. No Terragrunt is installed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { terragruntUnitPlace, UnitPlaceError } from "./place";
import type { TerragruntExec } from "./run";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "chant-tg-place-")));

describe("terragruntUnitPlace (chant#4910)", () => {
  test("the unit's working directory, and the variables Terragrunt adds, from the wrapper's record", async () => {
    const project = tmp();
    const cache = join(project, ".terragrunt-cache", "abc", "unit");
    mkdirSync(cache, { recursive: true });
    const seen: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
    const exec: TerragruntExec = async (file, args, o) => {
      seen.push({ file, args, cwd: o.cwd });
      const r = spawnSync(o.env.TG_TF_PATH!, ["init"], { cwd: cache, env: { ...o.env, TF_VAR_region: "eu-west-1" }, encoding: "utf-8" });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const place = await terragruntUnitPlace({ projectDir: project, unit: "live/queues", binary: "true", env: { PATH: process.env.PATH, JOB: "1" }, work: tmp(), exec });
    expect(seen[0]).toMatchObject({ file: "terragrunt", cwd: project });
    expect(seen[0]!.args).toEqual(["run", "--non-interactive", "--no-color", "--working-dir", "live/queues", "--", "init", "-input=false", "-no-color"]);
    expect(place.dir).toBe(cache);
    expect(place.env).toMatchObject({ JOB: "1", TF_VAR_region: "eu-west-1", TG_NON_INTERACTIVE: "true" });
    expect(place.env.TG_TF_PATH).toBeUndefined();
  });

  test("a failed init, or one that never runs the binary, is refused with why", async () => {
    const failed: TerragruntExec = async () => ({ code: 1, stdout: "", stderr: "ERROR no such unit" });
    await expect(terragruntUnitPlace({ projectDir: tmp(), unit: "u", binary: "tofu", env: {}, work: tmp(), exec: failed })).rejects.toThrow(new UnitPlaceError("terragrunt could not prepare u (init failed): ERROR no such unit"));
    const skipped: TerragruntExec = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(terragruntUnitPlace({ projectDir: tmp(), unit: "u", binary: "tofu", env: {}, work: tmp(), exec: skipped })).rejects.toThrow(/without running tofu/);
  });
});
