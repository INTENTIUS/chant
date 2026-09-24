/**
 * `chant run --generate <provider>` (#2533): the CLI for `generateOpsPipeline`
 * (../../op/generate-pipeline.ts), the Op counterpart to `chant build
 * --components --generate <lexicon>`.
 *
 * The generator is a library function with no caller of its own. A pipeline
 * committed to a repository needs a named command that regenerates it, so a
 * drift check (#2524 D14) can rerun that command and compare. This handler is
 * that command and adds nothing to the generator's output beyond one header
 * line: every file it writes is the generator's own `yaml`, byte for byte,
 * under a first line carrying {@link GENERATED_MARKER} and the command that
 * produced it.
 *
 * Where the specs come from:
 *
 *  - by default, every discovered Op that declares its own `schedule`, as a
 *    bare `{ name }` spec. `generateOpsPipeline` fills the cron in from the Op
 *    (`withOpSchedules`), so the result is exactly what a direct call with
 *    those names returns;
 *  - with `--spec <file>`, a JSON file holding either a `ScheduledOpSpec[]`
 *    or `{ ops, options }`, for Ops triggered by a pull request or a push, a
 *    finding mode, setup steps, or generator options. The file is passed to
 *    the generator unchanged.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { generateOpsPipeline } from "../../op/generate-pipeline";
import { GENERATED_MARKER } from "../../discovery/files";
import { findWorkspaceRoot } from "../../project-root";
import type { ComponentPipelineOptions, ScheduledOpSpec } from "../../lexicon";
import { formatBold, formatError, formatSuccess } from "../format";
import type { CommandContext } from "../registry";

/** Where each forge reads its pipeline files from, relative to the repository root. `--output` overrides it. */
export const DEFAULT_OP_PIPELINE_DIRS: Record<string, string> = {
  github: ".github/workflows",
  forgejo: ".forgejo/workflows",
  gitlab: ".",
};

/** The first line of every file this command writes. */
export function opPipelineHeader(provider: string, specFile?: string): string {
  const command = `chant run --generate ${provider}${specFile ? ` --spec ${specFile}` : ""}`;
  return `# ${GENERATED_MARKER}. Regenerate with: ${command}\n`;
}

interface SpecFile {
  ops: ScheduledOpSpec[];
  options?: ComponentPipelineOptions;
}

/** Read `--spec`: a `ScheduledOpSpec[]`, or `{ ops, options }`. Throws with the file named on anything else. */
export function readOpSpecFile(path: string): SpecFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`--spec ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const shape = "an array of Op specs, or { \"ops\": [...], \"options\": {...} }";
  const ops = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) throw new Error(`--spec ${path} must hold ${shape}`);
  for (const [i, spec] of ops.entries()) {
    if (typeof (spec as { name?: unknown })?.name !== "string") {
      throw new Error(`--spec ${path}: entry ${i} has no "name". Each entry names the Op it generates a pipeline for.`);
    }
  }
  const options = Array.isArray(parsed) ? undefined : (parsed as { options?: ComponentPipelineOptions }).options;
  return { ops: ops as ScheduledOpSpec[], ...(options ? { options } : {}) };
}

export async function runOpGenerate(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const provider = args.generate as string;
  const specPath = args.opsSpec;

  let ops: ScheduledOpSpec[];
  let options: ComponentPipelineOptions | undefined;
  if (specPath) {
    try {
      ({ ops, options } = readOpSpecFile(resolve(specPath)));
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  } else {
    const discovered = await discoverOps();
    if (discovered.errors.length > 0) {
      for (const e of discovered.errors) console.error(formatError({ message: e }));
      return 1;
    }
    ops = [...discovered.ops.entries()]
      .filter(([, op]) => op.config.schedule)
      .map(([name]) => name)
      .sort()
      .map((name) => ({ name }));
    if (ops.length === 0) {
      console.error(formatError({
        message: "No Op declares a schedule, so there is nothing to generate",
        hint: "Give an Op a `schedule`, or pass --spec <file.json> naming the Ops and their triggers.",
      }));
      return 1;
    }
  }

  // Inside a workspace member (#2542), the files are the member's: filtered
  // to its paths, run in its directory, named after it at the repository
  // root's forge directory, and recorded as its generated files. The
  // workspace module loads only when a declaration was found.
  const found = findWorkspaceRoot(process.cwd());
  let plan: import("../../workspace/member-pipeline").MemberOpPlan | undefined;
  let memberPipeline: typeof import("../../workspace/member-pipeline") | undefined;
  if (found) {
    memberPipeline = await import("../../workspace/member-pipeline");
    try {
      plan = memberPipeline.planMemberOpPipelines({ projectDir: process.cwd(), found, provider, output: args.output, specFile: specPath });
    } catch (err) {
      console.error(formatError({ message: memberPipeline.describeError(err) }));
      return 1;
    }
  }

  const result = await generateOpsPipeline(ops, provider, plan ? { ...options, member: plan.member } : options);
  if (!result.success) {
    console.error(formatError({ message: result.error ?? "Failed to generate Op pipelines" }));
    return 1;
  }

  if (plan && memberPipeline) {
    const header = memberPipeline.generatedHeader(plan.command);
    if (args.format === "json") {
      const files = (result.files ?? []).map((f) => ({
        name: f.name,
        path: memberPipeline.repoRelative(plan.ctx, join(plan.outDir, f.name)),
        content: header + f.yaml,
      }));
      console.log(JSON.stringify({ member: plan.member.name, files, jobs: result.jobs ?? [] }, null, 2));
      return 0;
    }
    for (const path of memberPipeline.writeMemberOpPipelines(plan, result.files ?? [])) {
      console.error(formatSuccess(`wrote ${formatBold(path)} for member ${formatBold(plan.member.name)}`));
    }
    return 0;
  }

  const header = opPipelineHeader(provider, specPath);
  const outDir = args.output ?? DEFAULT_OP_PIPELINE_DIRS[provider] ?? ".";
  const files = (result.files ?? []).map((f) => ({
    name: f.name,
    path: join(outDir, f.name),
    content: header + f.yaml,
  }));

  if (args.format === "json") {
    console.log(JSON.stringify({ files, jobs: result.jobs ?? [] }, null, 2));
    return 0;
  }

  for (const file of files) {
    const target = resolve(file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    console.error(formatSuccess(`wrote ${formatBold(file.path)}`));
  }
  return 0;
}
