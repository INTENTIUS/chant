/**
 * `chant release` (#4026, ws-104): the release is what graduates.
 *
 *   release cut [<label>] [--build <command>] [--param k=v]... [--params-file <file>] [--actor <name>] [--sign [<key file>]] [--json]
 *       cut a release of this member from the checkout's HEAD, which must be green;
 *       --sign signs the cut with the actor's ssh key (#4031)
 *   release list [--json]
 *       every release of this member with its targets, its cuts and where it runs;
 *       `--json` prints the read contract's `releases` document
 *   release compile --env <env> [--build <command>] [--artifacts --component <a,b>] --json
 *       internal: what the cut runs in a child process per environment
 *
 * The workstation UX for `cut` grows in #4027. A declaration whose
 * `identity.gates` names a `release` gate requires a signed cut by an actor
 * in its class (#4031).
 */

import { resolve } from "node:path";
import { formatBold, formatError, formatSuccess, formatWarning } from "../format";
import { parseParamFlags } from "../build-params-cli";
import type { CommandContext } from "../registry";

const USAGE =
  "chant release cut [<label>] [--build <command>] [--param <k=v>] [--params-file <file>] [--actor <name>] [--sign [<key file>]] [--json] | release list [--json]";

function resolveActor(ctx: CommandContext): string | undefined {
  return ctx.args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER;
}

export async function runReleaseCut(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const positional = args.extraPositional;
  if (positional && args.label && positional !== args.label) {
    console.error(formatError({ message: `the label is given twice, as "${positional}" and --label "${args.label}"`, hint: USAGE }));
    return 1;
  }
  const label = positional ?? args.label ?? null;
  const actor = resolveActor(ctx);
  if (!actor) {
    console.error(formatError({ message: "Could not resolve --actor from the environment", hint: "Pass --actor explicitly, or set GITHUB_ACTOR / GITLAB_USER_LOGIN / USER." }));
    return 1;
  }
  const cwd = resolve(".");
  const { spawnTargetCompiler, ReleaseCompileError } = await import("../../components/release-compile");
  const { cutRelease, ReleaseCutError } = await import("../../lifecycle/release-cut");
  const { ReleaseLabelError } = await import("../../lifecycle/release-store");
  const { pushLifecycleReport } = await import("../../lifecycle/git");
  const params = parseParamFlags(args.param);
  const compiler = spawnTargetCompiler({
    projectDir: cwd,
    ...(args.buildCommand ? { buildCommand: args.buildCommand } : {}),
    ...(params ? { params } : {}),
    ...(args.paramsFile ? { paramsFile: args.paramsFile } : {}),
  });
  try {
    const result = await cutRelease({ cwd, compiler, label, actor, ...(args.sign !== undefined ? { sign: args.sign } : {}) });
    const push = await pushLifecycleReport({ cwd }).catch(() => ({ pushed: false, pushWarning: undefined }));
    if (args.json) {
      console.log(JSON.stringify({ release: result.release, label: result.label, cut: result.cut, stored: result.stored, reused: result.reused }, null, 2));
    } else {
      const name = result.label ? formatBold(result.label) : "unlabelled release";
      if (result.cut) console.error(formatSuccess(`Cut ${name}: ${result.release.releaseDigest}`));
      else console.error(formatSuccess(`Already cut${result.label ? ` as ${formatBold(result.label)}` : ""}: ${result.release.releaseDigest}`));
      console.error(`  commit ${result.release.commit}`);
      if (result.cut) console.error(result.cut.signature ? `  signed by ${result.cut.actor}` : "  not signed");
      console.error(`  artifacts ${result.release.artifactDigests.length}, targets ${result.release.targets.map((t) => `${t.env} (${t.templates.length} template${t.templates.length === 1 ? "" : "s"})`).join(", ")}`);
      for (const r of result.reused) console.error(`  ${r.component}: artifacts unchanged, carried from ${r.from}`);
      console.log(result.release.releaseDigest);
    }
    if (push.pushWarning) console.error(formatWarning({ message: push.pushWarning }));
    return 0;
  } catch (err) {
    if (err instanceof ReleaseCutError) {
      console.error(formatError({ message: `${err.message} [${err.code}]`, ...(err.fix ? { hint: err.fix } : {}) }));
      return 1;
    }
    if (err instanceof ReleaseLabelError) {
      console.error(formatError({ message: `${err.message} [${err.code}]` }));
      return 1;
    }
    if (err instanceof ReleaseCompileError) {
      console.error(formatError({ message: `no release was cut: ${err.message}` }));
      return 1;
    }
    throw err;
  }
}

export async function runReleaseList(ctx: CommandContext): Promise<number> {
  const { releasesDocument } = await import("../../workspace/releases");
  const doc = await releasesDocument({ cwd: resolve(".") });
  if (ctx.args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: doc.error.message, hint: USAGE }));
    return 1;
  }
  if (doc.reason) console.error(formatWarning({ message: doc.reason.message }));
  if (doc.releases.length === 0) {
    console.error("No releases. Cut one from a green commit: chant release cut <label>");
    return 0;
  }
  for (const r of doc.releases) {
    const where = r.environments.map((e) => e.env).join(", ") || "not deployed from the release";
    // #4031: the newest cut's signature, as the policy at base judges it.
    const newest = r.cuts.at(-1);
    const signature = newest ? (newest.signatureCheck.status === "verified" ? `signed by ${newest.actor}` : newest.signatureCheck.status) : "-";
    console.log(`${(r.label ?? "-").padEnd(16)}  ${r.releaseDigest}  ${r.commit.slice(0, 12)}  ${signature}  ${where}`);
    if (newest?.signatureCheck.status === "unverified") console.error(`  ${r.label ?? r.releaseDigest}: ${newest.signatureCheck.reason}`);
  }
  return 0;
}

/** Internal: compile one environment, or build artifacts, in this process, and print the JSON the cut reads. */
export async function runReleaseCompile(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.env;
  if (!env) {
    console.error(formatError({ message: "release compile needs --env <env>" }));
    return 1;
  }
  const { compileEnvironment, buildReleaseArtifacts } = await import("../../components/release-compile");
  const params = parseParamFlags(args.param);
  const inputs = {
    projectDir: resolve("."),
    ...(args.buildCommand ? { buildCommand: args.buildCommand } : {}),
    ...(params ? { params } : {}),
    ...(args.paramsFile ? { paramsFile: args.paramsFile } : {}),
  };
  try {
    if (args.artifacts) {
      const names = (args.component ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      console.log(JSON.stringify({ artifacts: await buildReleaseArtifacts(inputs, env, names) }));
    } else {
      console.log(JSON.stringify(await compileEnvironment(inputs, env)));
    }
    return 0;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runReleaseUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({ message: `Unknown release subcommand: ${ctx.args.path}`, hint: USAGE }));
  return 1;
}
