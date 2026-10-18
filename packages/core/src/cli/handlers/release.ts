/**
 * `chant release` (#4026, ws-104): the release is what graduates.
 *
 *   release cut [<label>] [--yes] [--build <command>] [--param k=v]... [--params-file <file>] [--src <dir>] [-o <file>] [--lexicon <name>] [--actor <name>] [--sign [<key file>]] [--json]
 *       a dry run of a cut of this member from the checkout's HEAD, which must be
 *       clean, on trunk and pushed, and green (#4027); `--yes` cuts, records,
 *       and tags the commit `release/<label>` locally;
 *       --sign signs the cut with the actor's ssh key (#4031); `--src`, `-o` and
 *       `--lexicon` shape the build of a project with no components (#4046)
 *   release publish <label|digest> [--yes] [--allow-unsigned] [--require-provenance] [--json]
 *       publish a cut release (#4027) to the targets release.publish declares
 *       (#4047): a dry run unless --yes; refuses a revoked one, one with no
 *       signature that verifies against .chant/allowed_signers unless
 *       --allow-unsigned (#4049), and with a target a checkout that is not
 *       the release's commit; warns with no OIDC provenance, and refuses
 *       under --require-provenance; attaches SBOMs and provenance (#4049)
 *   release verify <label|digest> [--json]
 *       check the release's signature offline against .chant/allowed_signers
 *       at the release's commit (#4049)
 *   release list [--json]
 *       every release of this member with its targets, its cuts and where it runs;
 *       `--json` prints the read contract's `releases` document
 *   release export <label|digest> --env <env> [-o <dir>] [--json]
 *       write the files the release recorded for <env>, checked against their digests (#4046)
 *   release compile --env <env> [--build <command>] [--artifacts --component <a,b>] --json
 *       internal: what the cut runs in a child process per environment
 *
 * The workstation checks, the actor and the tag are in
 * ../../lifecycle/release-workstation.ts, and the publish contract in
 * ../../lifecycle/release-publish.ts. A declaration whose `identity.gates`
 * names a `release` gate requires a signed cut by an actor in its class (#4031).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatBold, formatError, formatSuccess, formatWarning } from "../format";
import { parseParamFlags } from "../build-params-cli";
import type { CommandContext } from "../registry";

const USAGE =
  "chant release cut [<label>] [--yes] [--build <command>] [--param <k=v>] [--params-file <file>] [--src <dir>] [-o <file>] [--lexicon <name>] [--actor <name>] [--sign [<key file>]] [--json] | release publish <label|digest> [--yes] [--allow-unsigned] [--require-provenance] [--json] | release verify <label|digest> [--json] | release list [--json] | release export <label|digest> --env <env> [-o <dir>] [--json]";

/** The build inputs `release cut` and `release compile` share. */
function compileInputs(ctx: CommandContext, params: Record<string, string> | undefined): import("../../components/release-compile").CompileInputs {
  const { args } = ctx;
  return {
    projectDir: resolve("."),
    ...(args.buildCommand ? { buildCommand: args.buildCommand } : {}),
    ...(params ? { params } : {}),
    ...(args.paramsFile ? { paramsFile: args.paramsFile } : {}),
    ...(args.src ? { src: args.src } : {}),
    ...(args.output ? { output: args.output } : {}),
    ...(args.lexicon ? { lexicon: args.lexicon } : {}),
  };
}

/** What to run after a cut (#4027): publish from CI, or push the tag so CI publishes, or deploy the first environment. */
export function nextCommands(req: {
  ref: string;
  tag: string | null;
  inCi: boolean;
  firstEnv: string | null;
  /** A project with no components deploys with `release export`, not promote (#4046). */
  noComponents: boolean;
}): string[] {
  const publish = `chant release publish ${req.ref}`;
  const deploy = req.firstEnv === null
    ? null
    : req.noComponents
      ? `chant release export ${req.ref} --env ${req.firstEnv}`
      : `chant components promote --release ${req.ref} --to ${req.firstEnv}`;
  if (req.inCi) return [publish, ...(deploy ? [deploy] : [])];
  return [...(req.tag ? [`git push origin ${req.tag}`] : []), publish, ...(deploy ? [deploy] : [])];
}

/** The command line that ran, without `--json`, with `--yes` added: what a dry run says to run next. */
export function sameWithYes(argv: readonly string[]): string {
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return ["chant", ...argv.filter((a) => a !== "--json" && a !== "--yes"), "--yes"].map(quote).join(" ");
}

function describeActorSource(source: import("../../lifecycle/release-workstation").ActorSource): string {
  switch (source) {
    case "flag":
      return "--actor";
    case "signer":
      return "the signers file at base, for the signing key";
    case "ci":
      return "the CI's actor";
    case "git":
      return "git user.email";
    case "user":
      return "$USER";
  }
}

/**
 * `release cut [<label>]` (#4026, #4027). A dry run unless `--yes`: it
 * refuses a dirty tree, a commit that is not on trunk and pushed, and one
 * that is not green, compiles every environment, and prints what the cut
 * would record, build and tag, and what publishes where. With `--yes` it
 * cuts, signs with `--sign`, records the cut with its actor and run id,
 * tags the commit locally and prints the next command.
 */
export async function runReleaseCut(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const positional = args.extraPositional;
  if (positional && args.label && positional !== args.label) {
    console.error(formatError({ message: `the label is given twice, as "${positional}" and --label "${args.label}"`, hint: USAGE }));
    return 1;
  }
  const label = positional ?? args.label ?? null;
  const dryRun = args.yes !== true;
  const cwd = resolve(".");
  const { spawnTargetCompiler, ReleaseCompileError } = await import("../../components/release-compile");
  const { cutRelease, planRelease, ReleaseCutError } = await import("../../lifecycle/release-cut");
  const { ReleaseLabelError } = await import("../../lifecycle/release-store");
  const { pushLifecycleReport, getHeadCommit } = await import("../../lifecycle/git");
  const { resolveCiRun } = await import("../../lifecycle/release-ledger");
  const ws = await import("../../lifecycle/release-workstation");
  const { detectProvenance, releasePublishTargets } = await import("../../lifecycle/release-publish");
  const fail = (code: string, message: string, fix?: string): number => {
    console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };

  try {
    // The workstation checks come first, in the order #4027 lists them; the
    // green check and the rest are the cut's own.
    const top = (() => {
      try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    })();
    let commit: string | null = null;
    let trunk: import("../../lifecycle/release-workstation").Trunk | null = null;
    let signers: readonly import("../../workspace/trust/trust-files").Signer[] = [];
    let member: string | null = null;
    if (top) {
      commit = await getHeadCommit({ cwd });
      ws.checkCleanTree(top, commit);
      const { scopeSource } = await import("../../workspace/write-scope");
      const { releaseRuleFrom } = await import("../../workspace/identity");
      const source = scopeSource(cwd);
      trunk = ws.resolveTrunk(top, source.declaration?.ci?.green?.branch ?? null);
      ws.checkOnTrunk(top, commit, trunk);
      signers = releaseRuleFrom(source).rule.signers.signers;
      const { resolveMemberLedger } = await import("../../lifecycle/member-ledger");
      const ledger = await resolveMemberLedger(cwd);
      member = ledger.members.length > 0 ? ledger.members.join("/") : null;
    }

    // The signing key is resolved now, so a dry run shows a key that can't be read.
    let publicKey: string | null = null;
    if (args.sign !== undefined) {
      const { resolveSigningKey, SealError } = await import("../../workspace/trust/seal");
      try {
        const key = resolveSigningKey(args.sign, cwd);
        try {
          if (!existsSync(key.file)) return fail("release-signer-refused", `no release was cut: the signing key ${key.file} does not exist`);
          publicKey = ws.publicKeyOf(key.file);
        } finally {
          key.cleanup();
        }
      } catch (err) {
        if (!(err instanceof SealError)) throw err;
        return fail("release-signer-refused", `no release was cut: ${err.message}`);
      }
    }
    const who = ws.resolveCutActor({ cwd, ...(args.actor ? { explicit: args.actor } : {}), publicKey, signers });
    if (!who) {
      console.error(formatError({ message: "Could not resolve --actor", hint: "Pass --actor explicitly, or set git's user.email, GITHUB_ACTOR, GITLAB_USER_LOGIN or USER." }));
      return 1;
    }
    const actor = who.actor;
    const tag = label !== null && commit !== null && top ? { name: ws.releaseTagName(member, label), state: ws.checkReleaseTag(top, ws.releaseTagName(member, label), commit) } : null;
    const ci = resolveCiRun(process.env);
    const params = parseParamFlags(args.param);
    const compiler = spawnTargetCompiler(compileInputs(ctx, params));
    const request = { cwd, compiler, label, actor, ...(args.sign !== undefined ? { sign: args.sign } : {}) };

    if (dryRun) {
      const plan = await planRelease(request);
      // Under the release gate, a key the signers file at base lists for someone else is refused now, not after the build.
      if (plan.signatureRequired && publicKey !== null && !signers.some((s) => s.key === publicKey && s.principal.trim().toLowerCase() === actor.trim().toLowerCase())) {
        return fail(
          "release-signer-refused",
          `no release would be cut: the signing key is not listed for ${actor} in the signers file at base, and identity.gates.release counts only a cut its signer signs`,
          "Pass --actor <principal> naming the key's signer, or sign with that principal's key.",
        );
      }
      const ref = plan.label ?? plan.alreadyCut ?? plan.releaseDigest;
      const provenance = detectProvenance();
      // The targets release publish would run, as the config here declares them; their files are read at publish.
      const publishTargets = await releasePublishTargets(cwd).then(
        (ts) => ts.map((t) => `${t.name} to ${t.destination}`),
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      );
      const deployRef = plan.label ?? "<label|digest>";
      const doc = {
        dryRun: true,
        ...plan,
        actor,
        actorSource: who.source,
        run: ci ? { runId: ci.runId, runOrigin: ci.runOrigin } : { runId: null, runOrigin: { forge: "local" as const } },
        trunk,
        sign: args.sign !== undefined ? { key: publicKey !== null ? publicKey.split(" ")[0] : null, readable: publicKey !== null } : null,
        tag: tag ? { name: tag.name, exists: tag.state === "present" } : null,
        publish: { targets: Array.isArray(publishTargets) ? publishTargets : [], provenance },
        next: [sameWithYes(process.argv.slice(2))],
      };
      if (args.json) {
        console.log(JSON.stringify(doc, null, 2));
        return 0;
      }
      const name = plan.label ? formatBold(plan.label) : "an unlabelled release";
      console.log(`Dry run: cut ${name} from commit ${plan.commit.slice(0, 12)}${trunk ? ` (on ${trunk.remote}/${trunk.branch}, green)` : ""}`);
      if (plan.alreadyCut) console.log(`  already cut as ${plan.alreadyCut}: the cut would record nothing new`);
      console.log(`  actor ${actor} (from ${describeActorSource(who.source)})`);
      console.log(`  run ${ci ? `${ci.runId} (${ci.runOrigin.forge})` : "minted on this machine at the cut (local)"}`);
      console.log(
        `  ${args.sign !== undefined ? `signed with ${publicKey ? publicKey.split(" ")[0] : "a key whose public half can't be read until it signs"}` : "not signed"}` +
          (plan.signatureRequired ? "; identity.gates.release requires a signed cut" : ""),
      );
      console.log(`  tag ${tag ? `${tag.name}${tag.state === "present" ? " (exists)" : ""}, made here and not pushed` : "none, since the release has no label"}`);
      for (const t of plan.targets) {
        console.log(`  ${t.env}: ${t.templates.length} template(s)${t.params.length > 0 ? `, ${t.params.map((p) => `${p.name}=${p.value}`).join(" ")}` : ""}`);
      }
      for (const b of plan.build) console.log(`  ${b.component}: artifacts built in ${b.env}`);
      for (const r of plan.reused) console.log(`  ${r.component}: artifacts unchanged, carried from ${r.from}`);
      console.log(`  digest ${plan.releaseDigest ?? "decided when the artifacts are built"}`);
      console.log("What will be published where:");
      if (plan.publishSteps.length === 0) console.log("  no component declares a publish step");
      for (const p of plan.publishSteps) {
        console.log(`  ${p.component}: ${p.kind}${p.to ? ` to ${p.to}` : ""} in ${p.envs.join(", ")}, by that environment's deploy (chant components promote --release ${deployRef})`);
      }
      const publishCmd = `chant release publish ${ref ?? "<label|digest>"}`;
      if (!Array.isArray(publishTargets)) console.log(`  ${publishCmd}: the publish targets can't be read: ${publishTargets.message}`);
      else if (publishTargets.length === 0) console.log(`  ${publishCmd}: nothing, since this member declares no publish target (release.publish in chant.config.ts)`);
      else for (const t of publishTargets) console.log(`  ${publishCmd}: ${t}`);
      if (!provenance.oidc) console.log(`  a publish from here would carry no OIDC provenance: ${provenance.reason}`);
      console.error(`Dry run: nothing was cut, signed or tagged. Run again with --yes to cut: ${doc.next[0]}`);
      return 0;
    }

    const result = await cutRelease(request);
    const push = await pushLifecycleReport({ cwd }).catch(() => ({ pushed: false, pushWarning: undefined }));
    // The tag names the release's label, which a re-cut with no label reads from the earlier cut.
    let tagged: { name: string; created: boolean } | null = null;
    let tagWarning: string | undefined;
    if (result.label !== null && top) {
      const name = ws.releaseTagName(member, result.label);
      try {
        const state = ws.checkReleaseTag(top, name, result.release.commit);
        if (state === "absent") ws.createReleaseTag(top, name, result.release.commit, { releaseDigest: result.release.releaseDigest, label: result.label, member });
        tagged = { name, created: state === "absent" };
      } catch (err) {
        tagWarning = `the release was cut, and the commit was not tagged: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const firstEnv = result.release.targets[0]?.env ?? null;
    const next = nextCommands({
      ref: result.label ?? result.release.releaseDigest,
      tag: tagged?.name ?? null,
      inCi: ci !== undefined,
      firstEnv,
      noComponents: result.release.targets.every((t) => t.templates.every((tpl) => tpl.component === null)) && result.release.artifactDigests.length === 0,
    });
    if (args.json) {
      console.log(
        JSON.stringify(
          { dryRun: false, release: result.release, label: result.label, cut: result.cut, stored: result.stored, reused: result.reused, actor, actorSource: who.source, tag: tagged, next },
          null,
          2,
        ),
      );
    } else {
      const name = result.label ? formatBold(result.label) : "unlabelled release";
      if (result.cut) console.error(formatSuccess(`Cut ${name}: ${result.release.releaseDigest}`));
      else console.error(formatSuccess(`Already cut${result.label ? ` as ${formatBold(result.label)}` : ""}: ${result.release.releaseDigest}`));
      console.error(`  commit ${result.release.commit}`);
      if (result.cut) console.error(`  ${result.cut.signature ? `signed by ${result.cut.actor}` : `not signed; actor ${result.cut.actor}`}, run ${result.cut.runId}`);
      console.error(`  artifacts ${result.release.artifactDigests.length}, targets ${result.release.targets.map((t) => `${t.env} (${t.templates.length} template${t.templates.length === 1 ? "" : "s"})`).join(", ")}`);
      for (const r of result.reused) console.error(`  ${r.component}: artifacts unchanged, carried from ${r.from}`);
      if (tagged) console.error(`  tag ${tagged.name}${tagged.created ? "" : " (already there)"}, not pushed`);
      console.error(`Next: ${next[0]}`);
      for (const n of next.slice(1)) console.error(`  or: ${n}`);
      console.log(result.release.releaseDigest);
    }
    if (push.pushWarning) console.error(formatWarning({ message: push.pushWarning }));
    if (tagWarning) console.error(formatWarning({ message: tagWarning }));
    return 0;
  } catch (err) {
    if (err instanceof ws.WorkstationCheckError || err instanceof ReleaseCutError) {
      return fail(err.code, err.message, err.fix);
    }
    if (err instanceof ReleaseLabelError) return fail(err.code, err.message);
    if (err instanceof ReleaseCompileError) {
      console.error(formatError({ message: `no release was cut: ${err.message}` }));
      return 1;
    }
    throw err;
  }
}

/**
 * `release publish <label|digest> [--yes]` (#4027, #4047): publish a cut
 * release to the targets the member declares under `release.publish` in
 * its `chant.config.ts`. It refuses a release no cut names, one cut from a
 * revoked commit, one with no signature that verifies against the signers
 * file at base unless `--allow-unsigned` (#4049; never under
 * identity.gates.release), and, when there is a target, a checkout that is
 * not the release's commit with a clean tree. It warns before publishing
 * when the run has no OIDC token, so what it publishes carries no
 * provenance, and refuses under `--require-provenance`. Each target attaches
 * an SBOM and the release's provenance statement (#4049). Every
 * target is planned (its files read and checked, its credentials found)
 * before any publishes. Without `--yes` it is a dry run that prints the plan
 * and uploads nothing. With `--yes` it stages every target, then reveals them
 * (#4048, `runPublish`), recording each step in `_releases/publishes.jsonl`,
 * so running it again after a failure resumes. Every line is redacted.
 */
export async function runReleasePublish(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  if (!ref) {
    console.error(formatError({ message: "release publish needs a release", hint: USAGE }));
    return 1;
  }
  const dryRun = args.yes !== true;
  const cwd = resolve(".");
  const fail = (code: string, message: string, fix?: string): number => {
    console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };
  const { fetchLifecycle } = await import("../../lifecycle/git");
  const { preparePublish, publishContext, runPublish, PublishTargetError, PublishRunError } = await import("../../lifecycle/release-publish");
  const { publishProgress, progressOf, readPublishRecords } = await import("../../lifecycle/publish-record");
  await fetchLifecycle({ cwd }).catch(() => false);
  const prepared = await preparePublish({ cwd, ref, allowUnsigned: args.allowUnsigned === true, requireProvenance: args.requireProvenance === true });
  if ("refusal" in prepared) return fail(prepared.refusal.code, prepared.refusal.message, prepared.refusal.fix);
  const { release, label, signature, provenance, warning, signatureWarning, targets, redactor } = prepared;
  const name = label ?? release.releaseDigest;
  const deploySteps = release.targets.map((t) => t.env);
  const say = (line: string) => console.error(redactor.redact(line));
  const failed = (code: string, message: string, fix?: string) => fail(code, redactor.redact(message), fix);
  const errorOf = (err: unknown): { code: string; message: string; fix?: string } =>
    err instanceof PublishTargetError ? { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) } : { code: "publish-failed", message: err instanceof Error ? err.message : String(err) };

  if (!args.json) {
    say(`${dryRun ? "Dry run: publish" : "Publishing"} ${formatBold(name)} (${release.releaseDigest}) from commit ${release.commit.slice(0, 12)}`);
    say(`  ${signature.status === "verified" ? `signed by ${signature.actor}` : signature.status === "unsigned" ? "not signed" : `signature unverified: ${signature.reason}`}`);
  }
  // The warnings go to stderr with --json too, before any target runs.
  if (signatureWarning) console.error(formatWarning({ message: signatureWarning }));
  if (warning) console.error(formatWarning({ message: warning }));
  const pctx = publishContext(prepared, { cwd, log: (line) => (args.json ? undefined : console.error(`    ${line}`)) });

  // Every target is planned before any publishes, so a missing file or credential stops the publish with nothing sent.
  const progress = publishProgress(await readPublishRecords(release.releaseDigest, { cwd }).catch(() => []));
  const planned: Array<{ kind: string; name: string; destination: string; progress: "none" | "staged" | "revealed"; items: import("../../lifecycle/release-publish").PublishItem[] }> = [];
  for (const target of targets) {
    try {
      planned.push({ kind: target.kind, name: target.name, destination: target.destination, progress: progressOf(progress, target), items: await target.plan(pctx) });
    } catch (err) {
      const e = errorOf(err);
      return failed(e.code, `nothing was published: ${target.name}: ${e.message}`, e.fix);
    }
  }
  const promoteHint = (): string | null => {
    if (deploySteps.length === 0) return null;
    const noComponents = release.artifactDigests.length === 0 && release.targets.every((t) => t.templates.every((tpl) => tpl.component === null));
    return noComponents
      ? `  Each environment deploys the files the release recorded: chant release export ${name} --env ${deploySteps[0]}`
      : `  A component's publish steps run in each environment's deploy of the release: chant components promote --release ${name} --to ${deploySteps[0]}`;
  };
  const base = { releaseDigest: release.releaseDigest, label, commit: release.commit, signature, provenance, warnings: [signatureWarning, warning].filter((w): w is string => w !== null) };

  if (dryRun) {
    const next = [sameWithYes(process.argv.slice(2))];
    if (args.json) {
      console.log(redactor.redact(JSON.stringify({ dryRun: true, ...base, targets: planned, published: [], environments: deploySteps, next }, null, 2)));
      return 0;
    }
    const out = (line: string) => console.log(redactor.redact(line));
    out("What would be published where:");
    if (planned.length === 0) out("  nothing: this member declares no publish target (release.publish in chant.config.ts)");
    for (const p of planned) {
      const earlier = p.progress === "revealed" ? " (published by an earlier run; skipped)" : p.progress === "staged" ? " (staged by an earlier run; only revealed)" : "";
      out(`  ${p.name}${provenance.oidc && p.kind === "npm" ? ", with --provenance" : ""}${earlier}:`);
      for (const i of p.items) out(`    ${describeItem(i)}`);
    }
    say(`Dry run: nothing was published. Run again with --yes to publish: ${next[0]}`);
    const hint = planned.length === 0 ? promoteHint() : null;
    if (hint) say(hint);
    return 0;
  }

  if (targets.length > 0 && !args.json) say("  every target stages first, and none is visible until all have staged");
  let run: import("../../lifecycle/release-publish").PublishRun;
  try {
    run = await runPublish({ cwd, release, label, targets, ctx: pctx, say: (line) => (args.json ? undefined : say(line)) });
  } catch (err) {
    if (err instanceof PublishRunError) {
      const again = sameWithYes(process.argv.slice(2));
      const where =
        err.step === "stage"
          ? `nothing is visible yet${err.staged.length > 0 ? `; staged: ${err.staged.join(", ")}` : ""}`
          : `revealed: ${err.revealed.length > 0 ? err.revealed.join(", ") : "none"}; staged and not yet revealed: ${err.staged.filter((t) => !err.revealed.includes(t)).join(", ")}`;
      return failed(err.code, `${err.message}; ${where}`, `${err.fix ? `${err.fix} ` : ""}Run the same command again to resume; what went out is not published again: ${again}`);
    }
    const e = errorOf(err);
    return failed(e.code, e.message, e.fix);
  }
  const { published } = run;
  if (run.recordWarning && targets.length > 0) console.error(formatWarning({ message: redactor.redact(`${run.recordWarning}. A resume asks the registries what is already there.`) }));
  if (args.json) {
    console.log(redactor.redact(JSON.stringify({ dryRun: false, ...base, targets: planned, published, resumed: run.resumed, environments: deploySteps }, null, 2)));
    return 0;
  }
  if (targets.length === 0) {
    say("Nothing was published: this member declares no publish target (release.publish in chant.config.ts).");
    const hint = promoteHint();
    if (hint) say(hint);
  } else {
    for (const p of published) for (const i of p.items) say(`  ${i.present ? "already there" : "published"}: ${describeItem(i)}`);
    console.error(formatSuccess(`Published ${name} to ${published.length} target(s)`));
  }
  return 0;
}

/** One item a target publishes, for a line: what, where, and the SBOM or attachment it is (#4049). */
function describeItem(i: import("../../lifecycle/release-publish").PublishItem): string {
  const what = i.attachment === "sbom" ? `${i.name} (SBOM)` : i.attachment === "provenance" ? `${i.name} (provenance)` : i.name;
  return `${what} to ${i.destination}${i.sbom ? `, carrying ${i.sbom}` : ""}`;
}

/**
 * `release verify <label|digest> [--json]` (#4049): check, offline, that the
 * release was signed by a key `.chant/allowed_signers` lists at the release's
 * commit, and that its file is the digest of what it holds. Exits 0 when it
 * verifies and 1 when it does not or can't be checked.
 */
export async function runReleaseVerify(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  if (!ref) {
    console.error(formatError({ message: "release verify needs a release", hint: USAGE }));
    return 1;
  }
  const { verifyRelease, verificationCode } = await import("../../lifecycle/release-verify");
  const result = await verifyRelease({ cwd: resolve("."), ref });
  if ("error" in result) {
    if (args.json) console.log(JSON.stringify({ ref, error: result.error }, null, 2));
    else console.error(formatError({ message: `${result.error.message} [${result.error.code}]`, ...(result.error.fix ? { hint: result.error.fix } : {}) }));
    return 1;
  }
  const code = verificationCode(result);
  if (args.json) {
    console.log(JSON.stringify({ ...result, ...(code ? { error: { code, message: result.reason } } : {}) }, null, 2));
    return code ? 1 : 0;
  }
  const name = result.label ? `${formatBold(result.label)} (${result.releaseDigest})` : result.releaseDigest;
  for (const c of result.cuts) {
    console.log(`  cut by ${c.actor} at ${c.timestamp}: ${c.signatureCheck.status}${c.signatureCheck.key ? ` (${c.signatureCheck.key})` : ""}`);
  }
  if (code) {
    console.error(
      formatError({
        message: `${name} does not verify: ${result.reason} [${code}]`,
        hint: code === "release-digest-mismatch" ? "Do not publish or deploy it; cut the release again." : `Cut it again signed with a key ${result.signers.path} lists: chant release cut ${result.label ?? "<label>"} --sign --yes`,
      }),
    );
    return 1;
  }
  console.error(formatSuccess(`Verified ${name}: ${result.reason}`));
  return 0;
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
    // #4033: a release cut from a revoked commit says so at the end of its line, and why on stderr.
    console.log(`${(r.label ?? "-").padEnd(16)}  ${r.releaseDigest}  ${r.commit.slice(0, 12)}  ${signature}  ${where}${r.revoked ? "  revoked" : ""}`);
    if (newest?.signatureCheck.status === "unverified") console.error(`  ${r.label ?? r.releaseDigest}: ${newest.signatureCheck.reason}`);
    if (r.revoked) {
      const { describeRevocation } = await import("../../lifecycle/release-revocation");
      console.error(`  ${r.label ?? r.releaseDigest}: revoked by ${r.revoked.tag}, ${describeRevocation(r.revoked)}`);
    }
  }
  return 0;
}

/**
 * `release export <label|digest> --env <env> [-o <dir>]` (#4046): write each
 * file the release's target for <env> records, at the path it was compiled to,
 * under <dir> (the member's directory by default), after checking each one's
 * bytes against its digest. This is how a project with no components deploys
 * a release: its own deploy reads these files instead of building again.
 */
export async function runReleaseExport(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  if (!ref || !args.env) {
    console.error(formatError({ message: "release export needs a release and an environment", hint: USAGE }));
    return 1;
  }
  const { fetchLifecycle } = await import("../../lifecycle/git");
  const { resolveRelease, readReleaseTemplate } = await import("../../lifecycle/release-store");
  const { targetFor, targetFiles, writePinnedTemplates } = await import("../../components/release-promote");
  await fetchLifecycle().catch(() => false);
  const found = await resolveRelease(ref);
  if (!found) {
    console.error(formatError({ message: `no release is labelled or digested "${ref}" in this member`, hint: "List them with: chant release list" }));
    return 1;
  }
  const target = targetFor(found.release, args.env);
  if ("error" in target) {
    console.error(formatError({ message: target.error }));
    return 1;
  }
  const read = await targetFiles(found.release, target.target, (digest) => readReleaseTemplate(digest));
  if ("errors" in read) {
    for (const e of read.errors) console.error(formatError({ message: e }));
    return 1;
  }
  const dir = resolve(args.output ?? ".");
  writePinnedTemplates(dir, read.files);
  if (args.json) {
    console.log(
      JSON.stringify(
        { releaseDigest: found.release.releaseDigest, label: found.label, env: args.env, dir, templates: target.target.templates, params: target.target.params },
        null,
        2,
      ),
    );
  } else {
    console.error(formatSuccess(`Wrote ${read.files.length} file(s) of ${found.label ? formatBold(found.label) : found.release.releaseDigest} for "${args.env}"`));
    for (const f of read.files) console.log(f.path);
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
  const inputs = compileInputs(ctx, params);
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
