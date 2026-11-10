/**
 * A waves spec the job renders at run time (#4982).
 *
 * A generated waves pipeline reads its spec from the file at `specFile`,
 * and each wave job reads the gate policy from that file at the base
 * commit. A product whose spec is built from its own config (terragucci
 * builds `tf-apply` from `terragucci.yml` at base: the gate per
 * environment, the approval mode, the policy and cost holds) cannot commit
 * the spec once, so it used to render its own apply-wave jobs.
 *
 * With `renderSpec` on the generator's options, every wave, deciding and
 * share job, and the policy step, runs `chant run wave --render-spec`, and
 * `CHANT_WAVES_SPEC_COMMAND` on the job holds the product command that
 * prints the spec, as a JSON argv. chant runs that command with
 * `CHANT_WAVES_SPEC_AT` set to a commit and reads the spec from its
 * standard output:
 *
 * - at the base, for the spec the job runs, which chant writes over the
 *   file at `specFile` so the hooks, the decision record and the share
 *   jobs read the same one;
 * - at the base again, for the gate policy, the holds, the hooks and the
 *   evidence rules (`readOpWavePolicy`), in place of `git show
 *   <base>:<specFile>`;
 * - at a newer commit on the branch, for the stand-down (#4581).
 *
 * The command's output is the gate policy, so it must read the product's
 * config at the commit it is handed (`git show "$CHANT_WAVES_SPEC_AT:<file>"`),
 * never from the working tree, which holds the change. It exits 0 and
 * prints nothing when that commit has no config, which reads as a spec
 * missing at base: every wave's gate is `always`. Any other exit fails the
 * job.
 *
 * The spec the generator is handed is the pipeline's shape: its waves'
 * names, shares and job groups, runners, environments, `cloud` and
 * `holds.policy` decide the jobs and their steps. The rendered spec decides
 * the rules. A share or job group the shape has and the rendered spec does
 * not applies nothing and exits 0, since the job exists before the runs
 * are known.
 *
 * Nothing here imports the wave runner, so the generators' bundles take
 * the variables without it; `chant run wave` hands in its git reader.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import type { OpWaveShowAtBase } from "./op-waves-run";
import type { OpWavesSpec } from "./op-waves";

export { RUNTIME_WAVES_SPEC_FLOOR } from "../release-floors";

/** The job variable that holds the product command printing the spec, as a JSON argv. */
export const OP_WAVES_SPEC_COMMAND_ENV = "CHANT_WAVES_SPEC_COMMAND";
/** The variable chant hands that command: the full commit to render the spec at. */
export const OP_WAVES_SPEC_AT_ENV = "CHANT_WAVES_SPEC_AT";
/** The variable chant hands that command: the spec file's path, as the job names it. */
export const OP_WAVES_SPEC_FILE_ENV = "CHANT_WAVES_SPEC_FILE";
/** The `chant run wave` flag that renders the spec before the job runs. */
export const OP_WAVES_RENDER_SPEC_FLAG = "--render-spec";

/** `OpWavesPipelineOptions.renderSpec` (#4982). */
export interface OpWavesRenderSpec {
  /** The product command that prints the spec at `CHANT_WAVES_SPEC_AT`, such as `["terragucci", "waves-spec"]`. */
  command: string[];
}

/** What is wrong with a `renderSpec`, or nothing. */
export function opWavesRenderSpecProblems(value: unknown): string[] {
  const command = (value as { command?: unknown } | null)?.command;
  if (!Array.isArray(command) || command.length === 0 || command.some((w) => typeof w !== "string" || w.length === 0)) {
    return ['renderSpec.command must be the product command that prints the spec, as a list of words: ["terragucci", "waves-spec"]'];
  }
  return [];
}

/** The variables a wave job carries for `renderSpec`, or none without it. Throws on a `renderSpec` that is wrong. */
export function opWavesRenderSpecEnv(renderSpec: OpWavesRenderSpec | undefined): Record<string, string> {
  if (renderSpec === undefined) return {};
  const problems = opWavesRenderSpecProblems(renderSpec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { [OP_WAVES_SPEC_COMMAND_ENV]: JSON.stringify(renderSpec.command) };
}

/** The product command `CHANT_WAVES_SPEC_COMMAND` names. Throws when it is unset or not a JSON list of words. */
export function opWavesSpecCommandFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[OP_WAVES_SPEC_COMMAND_ENV];
  if (!raw) throw new Error(`${OP_WAVES_RENDER_SPEC_FLAG} runs the command ${OP_WAVES_SPEC_COMMAND_ENV} names, and it is unset`);
  let command: unknown;
  try {
    command = JSON.parse(raw);
  } catch {
    command = undefined;
  }
  if (opWavesRenderSpecProblems({ command }).length > 0) throw new Error(`${OP_WAVES_SPEC_COMMAND_ENV} must be a JSON list of words, such as ["terragucci","waves-spec"]: got ${raw}`);
  return command as string[];
}

/** Prints the spec at a full commit, or null when that commit has none. Injected for tests. */
export type OpWavesSpecRender = (sha: string) => string | null;

/** {@link OpWavesSpecRender} through the product's command, run in `cwd`. Its standard error goes to the job's log. */
export function commandSpecRender(command: readonly string[], specFile: string, cwd: string): OpWavesSpecRender {
  return (sha) => {
    let out: string;
    try {
      out = execFileSync(command[0]!, command.slice(1), {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, [OP_WAVES_SPEC_AT_ENV]: sha, [OP_WAVES_SPEC_FILE_ENV]: specFile },
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      const status = (err as { status?: number | null }).status;
      throw new Error(`the spec command (${command.join(" ")}) ${typeof status === "number" ? `exited ${status}` : `did not run: ${err instanceof Error ? err.message : String(err)}`} at ${sha.slice(0, 12)}, so the wave's spec cannot be read`);
    }
    return out.trim() === "" ? null : out;
  };
}

const posixPath = (p: string): string => p.replace(/^\.\//, "").split("\\").join(posix.sep);

/**
 * An {@link OpWaveShowAtBase} that reads `specFile` at any commit from
 * `render`, once per commit, and every other file through `fallback`
 * (git, `gitShowAtBase`), which also resolves the commit.
 */
export function renderedSpecShow(specFile: string, render: OpWavesSpecRender, fallback: OpWaveShowAtBase): OpWaveShowAtBase {
  const target = posixPath(specFile);
  const seen = new Map<string, string | null>();
  return (base, path, cwd) => {
    if (posixPath(path) !== target) return fallback(base, path, cwd);
    const { sha } = fallback(base, path, cwd);
    if (!seen.has(sha)) seen.set(sha, render(sha));
    return { sha, text: seen.get(sha)! };
  };
}

/**
 * Render the job's spec at `base` (#4982): read it through `show`, parse it
 * with `parse` (`parseOpWavesSpec`), write it over `specFile` in `cwd`, and
 * return it. Throws when the command printed no spec, or one chant cannot
 * read.
 */
export function renderOpWavesSpecFile(options: { specFile: string; base: string; cwd: string; show: OpWaveShowAtBase; parse: (text: string, where: string) => OpWavesSpec }): { spec: OpWavesSpec; sha: string } {
  const { sha, text } = options.show(options.base, options.specFile, options.cwd);
  if (text === null) throw new Error(`the spec command printed no spec at ${options.base} (${sha.slice(0, 12)}), so the wave has nothing to run`);
  const spec = options.parse(text, `the spec rendered at ${sha.slice(0, 12)}`);
  const path = isAbsolute(options.specFile) ? options.specFile : join(options.cwd, options.specFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
  return { spec, sha };
}

/**
 * Whether job `job` of wave `k` has anything in the rendered spec: a share
 * past the wave's (or the group's) shares, or a group the wave does not
 * have, has nothing. Undefined when it has; otherwise why not.
 */
export function renderedJobMissing(spec: OpWavesSpec, k: number, job: { share?: number; group?: string }): string | undefined {
  const wave = spec.waves[k - 1];
  if (!wave) return undefined;
  if (job.group !== undefined) {
    const group = wave.jobs?.find((g) => g.name === job.group);
    if (!group) return `wave ${k} (${wave.name}) has no job group "${job.group}" in the spec rendered at base`;
    if (job.share !== undefined && job.share > (group.shares ?? 1)) return `job group "${job.group}" of wave ${k} (${wave.name}) has ${group.shares ?? 1} share${(group.shares ?? 1) === 1 ? "" : "s"} in the spec rendered at base`;
    return undefined;
  }
  if (job.share !== undefined && wave.jobs === undefined && job.share > (wave.shares ?? 1)) return `wave ${k} (${wave.name}) has ${wave.shares ?? 1} share${(wave.shares ?? 1) === 1 ? "" : "s"} in the spec rendered at base`;
  return undefined;
}
