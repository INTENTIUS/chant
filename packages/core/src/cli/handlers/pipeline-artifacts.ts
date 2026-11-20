/**
 * `chant pipeline artifacts` and `chant pipeline release-of` (#5356): the
 * release artifacts a stage publishes and later stages and other
 * repositories read. See ../../pipeline/artifacts.ts.
 *
 *   pipeline artifacts publish --stage <stage> [--release <label|digest>] [--dry-run] [--json]
 *       publish the artifacts the stage declares, for the release named, or
 *       the release cut from HEAD. The declarations are read from the
 *       pipeline on the default branch, as the stage's gates are. A wave job
 *       runs it after the first stage's release cut.
 *   pipeline artifacts read --stage <stage> [--release <label|digest>] [--name <artifact>] [--from <dir>] [--json]
 *       print the artifacts the stage published for the release named, else
 *       for the release in CHANT_CONTROL_RELEASE, else for the release it
 *       last published for. --from reads another repository's records: a
 *       checkout of it, or a directory holding its chant/lifecycle.
 *   pipeline release-of <commit>
 *       print the digest of the release cut from the commit; exit 1 when none
 */

import { resolve } from "node:path";
import type { CommandContext } from "../registry";
import { formatError, formatInfo, formatWarning } from "../format";
import {
  gitStageArtifactPort,
  publishStageArtifacts,
  readStageArtifacts,
  releaseCutFrom,
  stageArtifactsNote,
  stageArtifactText,
  STAGE_ARTIFACTS_RELEASE_ENV,
  type MemberOutputs,
  type PublishStageArtifactsResult,
} from "../../pipeline/artifacts";
import type { PipelineSpec } from "../../pipeline/spec";

const USAGE =
  "chant pipeline artifacts publish --stage <stage> [--release <label|digest>] [--dry-run] [--json] | chant pipeline artifacts read --stage <stage> [--release <label|digest>] [--name <artifact>] [--from <dir>] [--json] | chant pipeline release-of <commit>";

/** The pipeline on the default branch, or why there is none to read. */
async function pipelineAtBase(cwd: string): Promise<PipelineSpec | string> {
  const { promoteBase, readPipelineAt, readMemberPipeline } = await import("../../pipeline/read");
  const base = promoteBase(cwd);
  const read = base ? readPipelineAt(base, cwd) : readMemberPipeline(cwd);
  if (read.status === "absent") return "this member has no pipeline";
  if (read.status === "refused") return `the pipeline does not fold: ${read.line}`;
  return read.spec;
}

/** A release by label or digest, on the ledger at `cwd`. */
async function releaseNamed(ref: string, cwd: string): Promise<{ digest: string; label: string | null; commit: string } | undefined> {
  const { resolveRelease } = await import("../../lifecycle/release-store");
  const found = await resolveRelease(ref, { cwd });
  return found ? { digest: found.release.releaseDigest, label: found.label, commit: found.release.commit } : undefined;
}

/** Reads each member's outputs in `env` through its steps' capabilities, as the replan step does. */
async function outputsReader(cwd: string, env: string): Promise<((member: string) => Promise<MemberOutputs | undefined>) | string> {
  const { loadChantConfig } = await import("../../config");
  const { resolveComponentTargets } = await import("../../components/cli-support");
  const { fanOutRegistry } = await import("../../components/fan-out-support");
  const { readMarkedOutputs } = await import("../../components/upstream-replan");
  const { config } = await loadChantConfig(cwd).catch(() => ({ config: {} as import("../../config").ChantConfig }));
  const targets = await resolveComponentTargets(cwd, "all");
  if (!targets.success) return targets.error ?? "Could not discover components";
  const registry = await fanOutRegistry(cwd, config);
  const byName = new Map(targets.targets.map((c) => [c.name, c]));
  return async (member) => {
    const component = byName.get(member);
    if (!component) return undefined;
    return readMarkedOutputs(component, registry, { env, component: member });
  };
}

/** Publish `stage`'s artifacts for `release` from `cwd`, and push the ledger. Shared by the command and the promote. */
export async function publishStageFrom(input: {
  cwd: string;
  spec: PipelineSpec;
  stage: string;
  release: { digest: string; label?: string | null; gitSha?: string };
  dryRun?: boolean;
}): Promise<PublishStageArtifactsResult> {
  const declared = input.spec.stages.find((s) => s.name === input.stage)?.publish;
  if (!declared || Object.keys(declared).length === 0) return { status: "none", stage: input.stage };
  const { ENV_VAR } = await import("../../env");
  const before = process.env[ENV_VAR];
  process.env[ENV_VAR] = input.stage;
  try {
    const reader = await outputsReader(input.cwd, input.stage);
    if (typeof reader === "string") return { status: "refused", stage: input.stage, problems: [reader] };
    const result = await publishStageArtifacts({ spec: input.spec, stage: input.stage, release: input.release, outputsOf: reader, port: gitStageArtifactPort({ cwd: input.cwd }), ...(input.dryRun ? { dryRun: true } : {}) });
    if (result.status === "published" && !input.dryRun) {
      const { pushLifecycleRebasing } = await import("../../lifecycle/git");
      const pushed = await pushLifecycleRebasing({ cwd: input.cwd }).catch((err: unknown) => ({ pushed: false, pushWarning: err instanceof Error ? err.message : String(err) }));
      if (!pushed.pushed && pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
    }
    return result;
  } finally {
    if (before === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = before;
  }
}

/** The lines a refused publish prints. They name artifacts, members and outputs, never a value. */
export function publishRefusedMessage(result: Extract<PublishStageArtifactsResult, { status: "refused" }>): string {
  return `stage "${result.stage}" published no artifacts: ${result.problems.join("; ")}`;
}

export async function runPipelineArtifacts(ctx: CommandContext): Promise<number> {
  const verb = ctx.args.extraPositional;
  if (verb === "publish") return runPublish(ctx);
  if (verb === "read") return runRead(ctx);
  console.error(formatError({ message: "chant pipeline artifacts takes publish or read", hint: USAGE }));
  return 1;
}

async function runPublish(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const stage = args.lockStage;
  if (!stage) {
    console.error(formatError({ message: "--stage <stage> is required", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  const { fetchLifecycle, getHeadCommit } = await import("../../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  const spec = await pipelineAtBase(cwd);
  if (typeof spec === "string") {
    console.error(formatError({ message: spec, hint: USAGE }));
    return 1;
  }
  let release: { digest: string; label: string | null; commit: string } | undefined;
  if (args.release) {
    release = await releaseNamed(args.release, cwd);
    if (!release) {
      console.error(formatError({ message: `no release is labelled or digested ${args.release}` }));
      return 1;
    }
  } else {
    const head = await getHeadCommit({ cwd }).catch(() => "");
    release = head ? await releaseCutFrom(head, { cwd }) : undefined;
    if (!release) {
      console.error(formatError({ message: `no release was cut from ${head ? head.slice(0, 12) : "HEAD"}, so stage "${stage}" has no release to publish artifacts for`, hint: "Name one with --release <label|digest>" }));
      return 1;
    }
  }
  const result = await publishStageFrom({ cwd, spec, stage, release: { digest: release.digest, label: release.label, gitSha: release.commit }, ...(args.dryRun ? { dryRun: true } : {}) });
  if (result.status === "refused") {
    console.error(formatError({ message: publishRefusedMessage(result) }));
    return 1;
  }
  if (result.status === "none") {
    console.error(formatInfo(`stage "${stage}" publishes no artifacts`));
    return 0;
  }
  if (args.json) console.log(JSON.stringify(result.record, null, 2));
  else process.stdout.write(stageArtifactsNote(result.record));
  return 0;
}

async function runRead(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const stage = args.lockStage;
  if (!stage) {
    console.error(formatError({ message: "--stage <stage> is required", hint: USAGE }));
    return 1;
  }
  const from = args.migrateFrom ? resolve(args.migrateFrom) : resolve(".");
  if (!args.migrateFrom) {
    const { fetchLifecycle } = await import("../../lifecycle/git");
    await fetchLifecycle({ cwd: from }).catch(() => false);
  }
  const ref = args.release ?? (process.env[STAGE_ARTIFACTS_RELEASE_ENV] || undefined);
  let digest: string | undefined;
  if (ref) {
    digest = ref.includes(":") ? ref : (await releaseNamed(ref, from))?.digest;
    if (!digest) {
      console.error(formatError({ message: `no release is labelled ${ref}` }));
      return 1;
    }
  }
  const record = await readStageArtifacts(gitStageArtifactPort({ cwd: from }), { stage, ...(digest ? { release: digest } : {}) });
  if (!record) {
    console.error(formatError({ message: `stage "${stage}" published no artifacts${digest ? ` for release ${digest}` : ""}` }));
    return 1;
  }
  if (args.selectName) {
    const entry = record.artifacts[args.selectName];
    if (!entry) {
      console.error(formatError({ message: `stage "${stage}" published no artifact "${args.selectName}" for release ${record.label ?? record.release}; it published ${Object.keys(record.artifacts).sort().join(", ")}` }));
      return 1;
    }
    console.log(args.json ? JSON.stringify(entry) : stageArtifactText(entry));
    return 0;
  }
  if (args.json) console.log(JSON.stringify(record, null, 2));
  else process.stdout.write(stageArtifactsNote(record));
  return 0;
}

export async function runPipelineReleaseOf(ctx: CommandContext): Promise<number> {
  const commit = ctx.args.extraPositional;
  if (!commit || !/^[0-9a-f]{7,64}$/.test(commit)) {
    console.error(formatError({ message: "pipeline release-of takes a commit sha", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  const { fetchLifecycle } = await import("../../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  const found = await releaseCutFrom(commit, { cwd });
  if (!found) {
    console.error(formatError({ message: `no release was cut from ${commit.slice(0, 12)}` }));
    return 1;
  }
  console.log(found.digest);
  return 0;
}
