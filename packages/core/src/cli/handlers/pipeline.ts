/**
 * `chant pipeline` (#5324): the member's folded pipeline.
 *
 *   pipeline spec [--stage <stage>] [--at <commit>]
 *       print the folded spec, or with --stage that stage's op-waves spec.
 *       With --at, or CHANT_WAVES_SPEC_AT set (a wave job's render), the file
 *       is folded as it stood at that commit, and a commit with no pipeline
 *       prints nothing and exits 0, which a wave job reads as a spec absent
 *       at base. A file outside the subset exits 1 with its finding.
 *   pipeline generate <github|gitlab|forgejo> [--output <dir>] [--format json]
 *       write the merge's waves workflow and the promote workflow
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GENERATED_MARKER } from "../../discovery/files";
import { OP_WAVES_SPEC_AT_ENV } from "../../op/op-waves-render-spec";
import { readMemberPipeline, readPipelineAt, type PipelineRead } from "../../pipeline/read";
import { stageWavesSpec } from "../../pipeline/stages";
import { PIPELINE_FILE } from "../../pipeline/spec";
import { formatBold, formatError, formatSuccess } from "../format";
import type { CommandContext } from "../registry";
import { DEFAULT_OP_PIPELINE_DIRS } from "./run-generate";

const USAGE = "chant pipeline spec [--stage <stage>] [--at <commit>] | chant pipeline generate <github|gitlab|forgejo> [--output <dir>] [--format json]";

function refused(read: Extract<PipelineRead, { status: "refused" }>): number {
  console.error(formatError({ message: `${read.line}`, hint: "A pipeline file stays inside the TypeScript-as-data subset: it is folded, never run." }));
  return 1;
}

export async function runPipelineSpec(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const at = args.at ?? process.env[OP_WAVES_SPEC_AT_ENV] ?? undefined;
  const read = at ? readPipelineAt(at, process.cwd()) : readMemberPipeline(process.cwd());
  if (read.status === "absent") {
    if (at) return 0;
    console.error(formatError({ message: `this member has no ${PIPELINE_FILE}`, hint: USAGE }));
    return 1;
  }
  if (read.status === "refused") return refused(read);
  try {
    const out = args.lockStage ? stageWavesSpec(read.spec, args.lockStage) : read.spec;
    console.log(JSON.stringify(out, null, 2));
    return 0;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runPipelineGenerate(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const provider = args.extraPositional;
  if (!provider) {
    console.error(formatError({ message: "pipeline generate needs a forge: github, gitlab or forgejo", hint: USAGE }));
    return 1;
  }
  const read = readMemberPipeline(process.cwd());
  if (read.status === "absent") {
    console.error(formatError({ message: `this member has no ${PIPELINE_FILE}`, hint: USAGE }));
    return 1;
  }
  if (read.status === "refused") return refused(read);
  const { generatePipeline } = await import("../../pipeline/generate");
  const result = await generatePipeline(read.spec, provider);
  if (!result.success) {
    console.error(formatError({ message: result.error ?? "Failed to generate the pipeline" }));
    return 1;
  }
  const header = `# ${GENERATED_MARKER}. Regenerate with: chant pipeline generate ${provider}\n`;
  const outDir = args.output ?? DEFAULT_OP_PIPELINE_DIRS[provider] ?? ".";
  const files = (result.files ?? []).map((f) => ({ name: f.name, path: join(outDir, f.name), content: header + f.yaml }));
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

export async function runPipelineUnknown(): Promise<number> {
  console.error(formatError({ message: "chant pipeline takes spec or generate", hint: USAGE }));
  return 1;
}
