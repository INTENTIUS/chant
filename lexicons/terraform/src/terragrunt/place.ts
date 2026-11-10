/**
 * Where a Terragrunt unit's binary runs (chant#4910): its working directory
 * and environment as Terragrunt prepares them, so a reader or writer of the
 * unit's state (a state migration, an export, an ephemeral environment) runs
 * the binary there as for a plain root.
 *
 * `terragrunt run -- init` in the unit, with `TG_TF_PATH` a wrapper that
 * records the directory and the environment Terragrunt runs the binary in
 * (its working directory, in Terragrunt's cache when the unit names a
 * source, with backend.tf and provider.tf generated, and its inputs as
 * `TF_VAR_` variables) and then runs the binary. The wrapper records with
 * the running Node (`process.execPath`), so it needs nothing on `PATH`.
 *
 * Lifted from terragucci's `unitPlace` (migrate.ts), so terragucci deletes
 * its copy.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultTerragruntExec, type TerragruntExec } from "./run";

/** Where a unit's binary runs: its directory, and the job's environment with what Terragrunt adds. */
export interface UnitPlace {
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** A unit Terragrunt could not prepare. */
export class UnitPlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitPlaceError";
  }
}

export interface UnitPlaceInput {
  /** The directory Terragrunt runs in; `unit` is relative to it. */
  projectDir: string;
  unit: string;
  /** The binary Terragrunt calls through the wrapper. */
  binary: string;
  env: NodeJS.ProcessEnv;
  /** A directory of the caller's, which the wrapper and its record go under. */
  work: string;
  /** The `terragrunt` executable. Default `terragrunt` on `PATH`. */
  terragrunt?: string;
  /** How Terragrunt runs. Default {@link defaultTerragruntExec}. */
  exec?: TerragruntExec;
}

/** The variables of the wrapper's own run that are not Terragrunt's additions. */
const SHELL_VARS = new Set(["TG_TF_PATH", "PWD", "OLDPWD", "SHLVL", "_"]);

/** The unit's place, as Terragrunt prepares it. Throws {@link UnitPlaceError} when its init fails or never runs the binary. */
export async function terragruntUnitPlace(input: UnitPlaceInput): Promise<UnitPlace> {
  const { unit, binary, env } = input;
  const capture = mkdtempSync(join(input.work, "unit-"));
  const file = join(capture, "place.json");
  const wrapper = join(capture, basename(binary) || "tofu");
  const q = (x: string): string => `'${x.replace(/'/g, `'\\''`)}'`;
  const record = `require("fs").writeFileSync(process.argv[1], JSON.stringify({ dir: process.cwd(), env: process.env }))`;
  writeFileSync(wrapper, `#!/bin/sh\n${q(process.execPath)} -e ${q(record)} ${q(file)}\nexec ${q(binary)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const run = await (input.exec ?? defaultTerragruntExec)(input.terragrunt ?? "terragrunt", ["run", "--non-interactive", "--no-color", "--working-dir", unit, "--", "init", "-input=false", "-no-color"], {
    cwd: input.projectDir,
    env: { ...(env as Record<string, string>), TG_TF_PATH: wrapper, TG_NON_INTERACTIVE: "true" },
  });
  if (run.code !== 0) throw new UnitPlaceError(`terragrunt could not prepare ${unit} (init failed): ${lastLines(run.stderr || run.stdout)}`);
  if (!existsSync(file)) throw new UnitPlaceError(`terragrunt prepared ${unit} without running ${binary}, so where it runs is not known`);
  const got = JSON.parse(readFileSync(file, "utf-8")) as { dir: string; env: Record<string, string> };
  // The binary's own variables from Terragrunt: the unit's inputs, and any credentials an iam_role gave it.
  const added = Object.fromEntries(Object.entries(got.env).filter(([k, v]) => env[k] !== v && !SHELL_VARS.has(k)));
  return { dir: got.dir, env: { ...env, ...added } };
}

const lastLines = (s: string, n = 4): string => s.trim().split("\n").slice(-n).join(" ").slice(0, 400);
