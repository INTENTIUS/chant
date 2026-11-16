/**
 * Publishing a release train as one set (#5136, design #5132 decision 5):
 * `chant workspace train publish <env> [<train>] [--yes]`.
 *
 * A train pins one release of every `chant` member. Its publish runs in a
 * checkout of the commit the train's new releases were cut from, and splits
 * the members in two:
 *
 * - a member whose release was cut from this commit is published by this run;
 * - a member pinned at a release cut from another commit must already be
 *   published: its publish record (`_releases/publishes.jsonl`) shows every
 *   target revealed, or each target that is not says its destination already
 *   serves the release's label (`PublishTarget.published`). Otherwise the
 *   publish refuses before anything stages.
 *
 * Every member it publishes is prepared as `chant release publish` prepares
 * one (`preparePublish`: revocation, signatures, provenance, a clean checkout
 * of the release's commit), and every target is planned, before anything
 * stages. The members are put in dependency layers from the names their
 * targets publish and need (`PublishTarget.names`, #5165), each qualified by
 * its kind (./lifecycle/publish-train-names.ts): npm package names and their
 * dependency, peer and optional keys; an image's repository; PyPI projects and
 * their `Requires-Dist`; crates and their dependencies; an extension and its
 * `extensionDependencies`; an MCP Registry entry and the packages and images
 * its `server.json` lists. A member's `release.dependsOn` adds the members a
 * manifest doesn't show. Members of one layer go in name order, so core
 * comes first.
 *
 * Then two passes, as `runPublish` does for one release (#4048), across the
 * whole train:
 *
 * 1. Stage every member's targets, layer by layer, so a failure leaves no
 *    member visible to a consumer.
 * 2. Run each member's `release.verify` commands (#5157), in layer order,
 *    with the whole train's staged references, unless a record shows a
 *    reveal. A failure is recorded in the member's record and stops the
 *    publish before the first layer reveals.
 * 3. Reveal layer by layer. Before the next layer, wait until each revealed
 *    target of this one resolves for a consumer (`PublishTarget.visible`:
 *    npm's `dist-tags.latest` names the version, an image's tags name its
 *    digest, an index or registry lists the version), so nothing is visible
 *    before what it needs is.
 *
 * Within a member, targets reveal in `revealOrder`: uploads at reveal after
 * the rest, and the MCP Registry last.
 *
 * A target whose stage is already visible (npm under `stage: false`) is not
 * staged up front: it publishes in pass 2, in its layer's turn, after the
 * layers before it are visible.
 *
 * Every step is recorded in the member's own publish record, so running the
 * same command after a failure resumes across members without publishing
 * again what went out, and `chant release publish` in one member reads the
 * same record.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { PublishItem, PublishedTarget, PublishContext, PublishDeps, PublishPlan, PublishTarget, StagedTarget } from "../lifecycle/release-publish";
import { PublishTargetError, revealOrder } from "../lifecycle/release-publish";
import type { Redactor } from "../lifecycle/publish-credentials";
import { readDeclaration } from "./declaration";
import { findTrain, readReleaseTrains, type ReadTrain, type TrainMember } from "./release-train";
import { locateWorkspace } from "./which-chant";

/** The first chant whose `chant workspace train publish` orders and resumes members of every target kind (#5165): the oci, forge, homebrew, index, marketplace, pypi, cargo, mcp-registry and tauri-updater targets name what they publish and need, say whether a pinned release is published, and wait until a reveal is served before the next layer; a member's `release.dependsOn` names members a manifest doesn't show. */
export const TRAIN_PUBLISH_TARGETS_FLOOR = "0.124.101";

/** One target of a member, as planned. */
export interface TrainPlannedTarget {
  name: string;
  kind: string;
  destination: string;
  /** What an earlier run of the publish did for it. */
  progress: "none" | "staged" | "revealed";
  items: PublishItem[];
}

/** One member of the train, as the publish sees it. */
export interface TrainPublishMember {
  member: string;
  label: string | null;
  releaseDigest: string;
  commit: string;
  /** `publish`: cut from this checkout's commit, published by this run. `pinned`: an earlier release, already published. */
  role: "publish" | "pinned";
  /** The dependency layer, 0 first; null for a pinned member. */
  layer: number | null;
  /** The members of this run it reveals after (#5165), from its targets' names and `release.dependsOn`. */
  after?: string[];
  targets: TrainPlannedTarget[];
}

/** A member's `release.verify` commands (#5157), and the targets of the train they can't see. */
export interface TrainVerifyPlan {
  member: string;
  steps: import("../lifecycle/publish-verify").VerifyStep[];
}

export interface TrainPublishRefusal {
  kind: "refused";
  code: string;
  message: string;
  fix?: string;
}

export type TrainPublishOutcome =
  | TrainPublishRefusal
  | { kind: "planned"; train: ReadTrain; members: TrainPublishMember[]; warnings: string[]; redactor: Redactor; verify: TrainVerifyPlan[] }
  | {
      kind: "published";
      train: ReadTrain;
      members: TrainPublishMember[];
      warnings: string[];
      redactor: Redactor;
      /** Each member this run published, with its targets revealed. */
      published: Array<{ member: string; targets: PublishedTarget[] }>;
      /** The targets an earlier run had staged or revealed, so this one did not stage them again. */
      resumed: Array<{ member: string; target: string; step: "staged" | "revealed" }>;
      recordWarning: string | null;
      verify: TrainVerifyPlan[];
      /** How the verify commands went: `passed`, or `skipped` when a reveal was already recorded; absent with none. */
      verified?: "passed" | "skipped";
      /** Why a member's floating tag (#5150) was not moved, one line each. */
      floatingWarnings?: string[];
    };

/** A train publish that stopped, with what it left staged and revealed (`<member>: <target>`), so a run of the same command resumes. */
export class TrainPublishRunError extends PublishTargetError {
  constructor(
    code: string,
    message: string,
    fix: string | undefined,
    readonly member: string,
    readonly step: "stage" | "verify" | "reveal" | "wait",
    readonly staged: string[],
    readonly revealed: string[],
  ) {
    super(code, message, fix);
    this.name = "TrainPublishRunError";
  }
}

export interface TrainPublishQuery {
  /** Any directory in the workspace whose train it publishes. */
  cwd: string;
  env: string;
  /** The train, by id or digest; the newest for `env` when absent. */
  train?: string;
  /** Publish; without it the publish is planned and nothing is sent. */
  yes?: boolean;
  allowUnsigned?: boolean;
  requireProvenance?: boolean;
  /** The environment credentials are read from. Default: `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  deps?: PublishDeps;
  /** A line of progress. Redacted. */
  say?: (line: string) => void;
  /** A line a target logs. Redacted. */
  log?: (line: string) => void;
  /** Write the publish records. Default true. */
  record?: boolean;
  now?: () => Date;
  /** Runs one `release.verify` command; the default runs it through the shell. */
  runVerify?: import("../lifecycle/publish-verify").VerifyRunner;
}

interface Prepared {
  m: TrainMember;
  dir: string;
  plan: PublishPlan;
  ctx: PublishContext;
  layer: number;
}

const refuse = (code: string, message: string, fix?: string): TrainPublishRefusal => ({ kind: "refused", code, message, ...(fix ? { fix } : {}) });

function headOf(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Dependency layers over `members` (pure): a member needs another when one
 * of the names it needs is one the other provides. Members of a cycle share
 * a layer. Each layer is sorted by name.
 */
export function trainLayers(members: ReadonlyArray<{ member: string; provides: readonly string[]; needs: readonly string[] }>): string[][] {
  const owner = new Map<string, string>();
  for (const m of members) for (const n of m.provides) owner.set(n, m.member);
  const deps = new Map(members.map((m) => [m.member, new Set(m.needs.map((n) => owner.get(n)).filter((o): o is string => o !== undefined && o !== m.member))]));
  const left = new Set(members.map((m) => m.member));
  const layers: string[][] = [];
  while (left.size > 0) {
    let ready = [...left].filter((m) => [...deps.get(m)!].every((d) => !left.has(d)));
    // A cycle can't be ordered; what is left shares the layer.
    if (ready.length === 0) ready = [...left];
    ready.sort((a, b) => a.localeCompare(b));
    for (const m of ready) left.delete(m);
    layers.push(ready);
  }
  return layers;
}

/** Each member's direct dependencies among `members` (pure), by the same rule as {@link trainLayers}. */
export function trainDependencies(members: ReadonlyArray<{ member: string; provides: readonly string[]; needs: readonly string[] }>): Map<string, string[]> {
  const owner = new Map<string, string>();
  for (const m of members) for (const n of m.provides) owner.set(n, m.member);
  return new Map(members.map((m) => [m.member, [...new Set(m.needs.map((n) => owner.get(n)).filter((o): o is string => o !== undefined && o !== m.member))].sort()]));
}

/** The name a member provides for `release.dependsOn` (#5165). */
const memberName = (member: string) => `member:${member}`;

/**
 * The paths (as `git status --porcelain` prints them) that are a member's
 * `release.version` file stamped with its label in `train` (#5154), across
 * the members this checkout publishes.
 */
async function trainStamps(root: string, head: string | null, train: ReadTrain, here: ReadonlyArray<{ member: string; label: string | null; dir: string }>): Promise<Set<string>> {
  const out = new Set<string>();
  if (head === null || here.length === 0) return out;
  let status: string;
  let top: string;
  try {
    status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return out;
  }
  if (status.trim() === "") return out;
  const { loadChantConfig } = await import("../config");
  const { stampedChanges } = await import("../lifecycle/release-version");
  const { trainPackageLabels } = await import("./train-range-labels");
  let labels: import("../lifecycle/release-version").RangeLabels | undefined;
  for (const m of here) {
    const version = (await loadChantConfig(m.dir).catch(() => null))?.config.release?.version;
    if (!version || m.label === null) continue;
    labels ??= await trainPackageLabels(train, root).catch(() => ({}));
    for (const p of stampedChanges({ cwd: m.dir, top, commit: head, config: version, label: m.label, status, trains: [labels] })) out.add(p);
  }
  return out;
}

/** Plan, and with `yes` publish, a release train (#5136). */
export async function publishTrain(query: TrainPublishQuery): Promise<TrainPublishOutcome> {
  const { preparePublish, publishContext, releasePublishTargets, detectProvenance } = await import("../lifecycle/release-publish");
  const { createRedactor } = await import("../lifecycle/publish-credentials");
  const { publishProgress, progressOf, readPublishRecords } = await import("../lifecycle/publish-record");
  const { resolveRelease } = await import("../lifecycle/release-store");
  const env = query.processEnv ?? process.env;
  const say = query.say ?? (() => undefined);
  const log = query.log ?? (() => undefined);

  const located = locateWorkspace(query.cwd);
  const root = located.rootOnDisk;
  const { records } = await readReleaseTrains(root, query.env);
  const train = findTrain(records, query.train);
  if (!train) {
    return query.train === undefined
      ? refuse("train-not-found", `no release train is recorded for ${query.env}`, `Record one with: chant workspace train ${query.env}`)
      : refuse("train-not-found", `no release train ${query.train} is recorded for ${query.env}`, `List them with: chant workspace train list ${query.env}`);
  }
  const across = train.members.filter((m) => m.repo !== undefined);
  if (across.length > 0) {
    return refuse("train-repo-members", `release train ${train.id} pins repo members (${across.map((m) => m.member).join(", ")}), and a train publish publishes chant members from this checkout`, "Publish each repo member in its own repository.");
  }
  const declaration = readDeclaration(located.tree, "");
  const dirOf = new Map(declaration.members.map((d) => [d.name, resolve(root, d.dir)]));
  const missing = train.members.filter((m) => !dirOf.has(m.member));
  if (missing.length > 0) return refuse("train-member-unknown", `release train ${train.id} pins ${missing.map((m) => m.member).join(", ")}, which the declaration does not list`);

  const head = headOf(root);
  const provenance = detectProvenance(env);
  const memberLog = (member: string, redactor: Redactor) => (line: string) => log(redactor.redact(`${member}: ${line}`));

  // Pinned at an earlier commit: already published, or the publish refuses before anything stages.
  const members: TrainPublishMember[] = [];
  const credentialEnv: string[] = [];
  for (const m of train.members.filter((x) => x.commit !== head)) {
    const dir = dirOf.get(m.member)!;
    let targets: PublishTarget[];
    try {
      targets = await releasePublishTargets(dir, query.deps);
    } catch (err) {
      return refuse("publish-config-invalid", `${m.member}: the publish targets can't be read: ${err instanceof Error ? err.message : String(err)}`, "Fix release.publish in the member's chant.config.ts.");
    }
    credentialEnv.push(...targets.flatMap((t) => t.credentialEnv));
    const progress = publishProgress(await readPublishRecords(m.releaseDigest, { cwd: dir }).catch(() => []));
    const name = `${m.member} ${m.label ?? m.releaseDigest}`;
    const unrevealed = targets.filter((t) => !progress.revealed.has(t.key));
    if (unrevealed.length > 0) {
      const found = await resolveRelease(m.releaseDigest, { cwd: dir });
      if (!found) return refuse("release-not-found", `${name}: the train pins release ${m.releaseDigest}, which no cut in the member names`);
      const redactor = createRedactor(env, targets.flatMap((t) => t.credentialEnv));
      const label = m.label ?? found.label;
      // #5165: the tag the cut made, which a forge release is named by.
      const releaseTag = label !== null ? await pinnedReleaseTag(dir, label) : null;
      const ctx: PublishContext = { release: found.release, label, releaseTag, provenance, cwd: dir, tag: null, env, redactor, log: memberLog(m.member, redactor) };
      for (const t of unrevealed) {
        const there = t.published ? await t.published(ctx).catch(() => null) : null;
        if (there !== true) {
          return refuse(
            "train-member-unpublished",
            `${name} was cut from commit ${m.commit.slice(0, 12)}, not this checkout's ${head ? head.slice(0, 12) : "commit"}, so this publish does not publish it, and it is not published: ${t.name} ${there === false ? "does not hold it" : "can't say whether it holds it"}, and its publish record shows no reveal. Nothing was published.`,
            `Publish it first from a checkout of ${m.commit.slice(0, 12)}: chant release publish ${m.label ?? m.releaseDigest} --yes, in ${m.member}. Or record a train that pins a published release of it.`,
          );
        }
      }
    }
    members.push({ member: m.member, label: m.label, releaseDigest: m.releaseDigest, commit: m.commit, role: "pinned", layer: null, targets: [] });
  }

  // Cut from this commit: prepared and planned, every one, before anything stages.
  const prepared: Array<Omit<Prepared, "layer">> = [];
  const warnings: string[] = [];
  // #5154: `chant workspace train prepare` stamps every member cut here in one checkout; each takes the others' stamps as the commit's.
  const stampedHere = await trainStamps(root, head, train, train.members.filter((x) => x.commit === head).map((m) => ({ member: m.member, label: m.label, dir: dirOf.get(m.member)! })));
  for (const m of train.members.filter((x) => x.commit === head)) {
    const dir = dirOf.get(m.member)!;
    const plan = await preparePublish({ cwd: dir, ref: m.releaseDigest, env, ...(query.deps ? { deps: query.deps } : {}), allowUnsigned: query.allowUnsigned === true, requireProvenance: query.requireProvenance === true, alsoStamped: stampedHere });
    if ("refusal" in plan) return refuse(plan.refusal.code, `${m.member}: ${plan.refusal.message}. Nothing was published.`, plan.refusal.fix);
    credentialEnv.push(...plan.targets.flatMap((t) => t.credentialEnv));
    for (const w of [plan.signatureWarning, plan.warning]) if (w && !warnings.includes(`${m.member}: ${w}`)) warnings.push(`${m.member}: ${w}`);
    const ctx = publishContext(plan, { cwd: dir, env, tag: plan.channel, log: memberLog(m.member, plan.redactor) });
    prepared.push({ m, dir, plan, ctx });
  }
  const redactor = createRedactor(env, credentialEnv);
  if (prepared.length === 0) {
    return refuse("train-nothing-cut-here", `release train ${train.id} has no release cut from this checkout's commit ${head ? head.slice(0, 12) : "(none)"}, so there is nothing for it to publish here`, "Run the publish in a checkout of the commit the train's new releases were cut from, as the job on its release-train tag does.");
  }

  // Layers from what each member's targets publish and need, and the members release.dependsOn names (#5165).
  const named: Array<{ member: string; provides: string[]; needs: string[] }> = [];
  for (const p of prepared) {
    const unknown = (p.plan.dependsOn ?? []).filter((d) => !dirOf.has(d));
    if (unknown.length > 0) {
      return refuse(
        "train-depends-on-unknown",
        `${p.m.member}: release.dependsOn names ${unknown.join(", ")}, which the declaration does not list. Nothing was published.`,
        `Name members of this workspace: ${[...dirOf.keys()].sort().join(", ")}.`,
      );
    }
    const provides: string[] = [memberName(p.m.member)];
    const needs: string[] = (p.plan.dependsOn ?? []).map(memberName);
    for (const t of p.plan.targets) {
      if (!t.names) continue;
      try {
        const n = await t.names(p.ctx);
        provides.push(...n.provides);
        needs.push(...n.needs);
      } catch {
        // A target that can't name what it publishes orders nothing; its plan below says why it can't publish.
      }
    }
    named.push({ member: p.m.member, provides, needs });
  }
  const layers = trainLayers(named);
  const afterOf = trainDependencies(named);
  const layerOf = new Map(layers.flatMap((l, i) => l.map((m) => [m, i] as const)));
  const ordered: Prepared[] = layers.flat().map((member) => ({ ...prepared.find((p) => p.m.member === member)!, layer: layerOf.get(member)! }));

  const progressOfMember = new Map<string, ReturnType<typeof publishProgress>>();
  for (const p of ordered) {
    const progress = publishProgress(await readPublishRecords(p.m.releaseDigest, { cwd: p.dir }).catch(() => []));
    progressOfMember.set(p.m.member, progress);
    const targets: TrainPlannedTarget[] = [];
    for (const t of p.plan.targets) {
      try {
        targets.push({ name: t.name, kind: t.kind, destination: t.destination, progress: progressOf(progress, t), items: await t.plan(p.ctx) });
      } catch (err) {
        const e = err instanceof PublishTargetError ? err : new PublishTargetError("publish-failed", err instanceof Error ? err.message : String(err));
        return refuse(e.code, redactor.redact(`nothing was published: ${p.m.member}: ${t.name}: ${e.message}`), e.fix);
      }
    }
    const after = afterOf.get(p.m.member) ?? [];
    members.push({ member: p.m.member, label: p.m.label, releaseDigest: p.m.releaseDigest, commit: p.m.commit, role: "publish", layer: p.layer, ...(after.length > 0 ? { after } : {}), targets });
  }
  members.sort((a, b) => (a.layer ?? -1) - (b.layer ?? -1) || a.member.localeCompare(b.member));
  // #5157: each member's release.verify, after the whole train has staged; a target whose stage is visible is out of its reach.
  const verify: TrainVerifyPlan[] = ordered.filter((p) => (p.plan.verify ?? []).length > 0 && p.plan.targets.length > 0).map((p) => ({ member: p.m.member, steps: p.plan.verify! }));
  if (verify.length > 0) {
    const { unstagedForVerify, unstagedWarning } = await import("../lifecycle/publish-verify");
    const unstaged = ordered.flatMap((p) => unstagedForVerify(p.plan.targets).map((n) => `${p.m.member}: ${n}`));
    if (unstaged.length > 0) warnings.push(unstagedWarning(unstaged));
  }
  if (!query.yes) return { kind: "planned", train, members, warnings, redactor, verify };

  const ran = await runTrain({ ordered, layers: layers.length, progressOfMember, verify, say: (l) => say(redactor.redact(l)), record: query.record ?? true, now: query.now ?? (() => new Date()), ...(query.runVerify ? { runVerify: query.runVerify } : {}) });
  // #5150: each member's floating tag moves once the whole train has revealed, unless one of its targets refused.
  const floatingWarnings: string[] = [];
  const { moveFloatingTag } = await import("../lifecycle/release-publish");
  for (const p of ordered) {
    const f = p.plan.floating;
    if (!f?.move) continue;
    const refused = ran.published.find((x) => x.member === p.m.member)?.targets.some((t) => t.warning);
    const w = refused ? `the floating tag ${f.name} was not moved, since a target refused the release` : moveFloatingTag(p.dir, f);
    if (w) floatingWarnings.push(`${p.m.member}: ${w}`);
  }
  return { kind: "published", train, members, warnings, redactor, verify, ...ran, floatingWarnings };
}

/** The tag `release.tag` gives `label` in the member at `dir`, or null when it can't be told. */
async function pinnedReleaseTag(dir: string, label: string): Promise<string | null> {
  try {
    const { memberTags, renderReleaseTag } = await import("../lifecycle/release-tag");
    const tags = await memberTags(dir);
    return renderReleaseTag(tags.template, tags.place, label);
  } catch {
    return null;
  }
}

/** The two passes over the prepared members (#5136). Throws {@link TrainPublishRunError}. */
async function runTrain(req: {
  ordered: Prepared[];
  layers: number;
  progressOfMember: Map<string, import("../lifecycle/publish-record").PublishProgress>;
  verify: readonly TrainVerifyPlan[];
  runVerify?: import("../lifecycle/publish-verify").VerifyRunner;
  say: (line: string) => void;
  record: boolean;
  now: () => Date;
}): Promise<{ published: Array<{ member: string; targets: PublishedTarget[] }>; resumed: Array<{ member: string; target: string; step: "staged" | "revealed" }>; recordWarning: string | null; verified?: "passed" | "skipped" }> {
  const { appendPublishRecord } = await import("../lifecycle/publish-record");
  const { pushLifecycleReport } = await import("../lifecycle/git");
  const { resolveRunId } = await import("../lifecycle/release-ledger");
  const { ordered, say } = req;
  let recordWarning: string | null = null;
  const stagedNames: string[] = [];
  const revealedNames: string[] = [];
  const resumed: Array<{ member: string; target: string; step: "staged" | "revealed" }> = [];
  const staged = new Map<string, StagedTarget>();
  const keyOf = (p: Prepared, t: PublishTarget) => `${p.m.member}\u0000${t.key}`;
  const shown = (p: Prepared, t: PublishTarget) => `${p.m.member}: ${t.name}`;

  const write = async (p: Prepared, target: Pick<PublishTarget, "key" | "name"> & { kind: PublishTarget["kind"] | "verify" }, step: import("../lifecycle/publish-record").PublishRecord["step"], items: PublishItem[], state: Record<string, string>) => {
    if (!req.record) return;
    try {
      const runId = resolveRunId(undefined, p.ctx.env).runId;
      await appendPublishRecord(
        { version: 1, releaseDigest: p.m.releaseDigest, label: p.plan.label, target: target.key, kind: target.kind, name: target.name, step, items, state, runId, timestamp: req.now().toISOString() },
        p.plan.redactor,
        { cwd: p.dir },
      );
      const push = await pushLifecycleReport({ cwd: p.dir });
      if (push.pushWarning && recordWarning === null) recordWarning = push.pushWarning;
    } catch (err) {
      recordWarning ??= `the publish record was not written: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const fail = (err: unknown, p: Prepared, target: PublishTarget, step: "stage" | "reveal" | "wait"): never => {
    const e = err instanceof PublishTargetError ? err : new PublishTargetError("publish-failed", err instanceof Error ? err.message : String(err));
    throw new TrainPublishRunError(e.code, p.plan.redactor.redact(`${shown(p, target)}: ${e.message}`), e.fix, p.m.member, step, [...stagedNames], [...revealedNames]);
  };
  // #5158: a target whose refusals are warnings, refused: reported with its warning, not revealed, not recorded.
  const refused = new Map<string, PublishedTarget>();
  const refusal = (p: Prepared, t: PublishTarget, err: unknown): PublishedTarget => {
    const why = p.plan.redactor.redact(err instanceof Error ? err.message : String(err));
    say(`  warning: ${shown(p, t)}: ${why}`);
    return { target: t.name, destination: t.destination, items: [{ name: t.name, destination: t.destination, refused: true }], warning: why };
  };
  const stage = async (p: Prepared, t: PublishTarget) => {
    say(`  ${p.m.member}: staging to ${t.destination}`);
    let s: StagedTarget;
    try {
      s = await t.stage(p.ctx);
    } catch (err) {
      if (t.refusalWarns) {
        refused.set(keyOf(p, t), refusal(p, t, err));
        return;
      }
      return fail(err, p, t, "stage");
    }
    staged.set(keyOf(p, t), s);
    stagedNames.push(shown(p, t));
    await write(p, t, "staged", s.items, s.state);
  };

  // Pass 1: stage every target that holds back what it stages, before any reveal.
  for (const p of ordered) {
    const progress = req.progressOfMember.get(p.m.member)!;
    for (const t of p.plan.targets) {
      if (progress.revealed.has(t.key)) continue;
      const earlier = progress.staged.get(t.key);
      if (earlier) {
        resumed.push({ member: p.m.member, target: t.name, step: "staged" });
        say(`  ${shown(p, t)}: staged by an earlier run; not staged again`);
        staged.set(keyOf(p, t), { ...earlier, target: t.name, destination: t.destination });
        stagedNames.push(shown(p, t));
        continue;
      }
      if (t.stagesVisibly) continue;
      await stage(p, t);
    }
  }

  // #5157: every member's release.verify, before the first layer reveals; not once any reveal is recorded.
  let verified: "passed" | "skipped" | undefined;
  const anyUnrevealed = ordered.some((p) => p.plan.targets.some((t) => !req.progressOfMember.get(p.m.member)!.revealed.has(t.key)));
  if (req.verify.length > 0 && anyUnrevealed) {
    if (ordered.some((p) => req.progressOfMember.get(p.m.member)!.revealed.size > 0)) {
      say("  verify: skipped, since an earlier run began revealing");
      verified = "skipped";
    } else {
      const { runVerifySteps, stagedReference, verifyKey } = await import("../lifecycle/publish-verify");
      const refs = ordered.flatMap((p) => p.plan.targets.filter((t) => staged.has(keyOf(p, t))).map((t) => stagedReference(t, staged.get(keyOf(p, t))!, p.m.member)));
      for (const v of req.verify) {
        const p = ordered.find((x) => x.m.member === v.member)!;
        const outcome = runVerifySteps({ cwd: p.dir, steps: v.steps, env: p.ctx.env, release: p.plan.release, label: p.plan.label, releaseTag: p.plan.releaseTag, staged: refs, say: (l) => say(l.replace(/^  /, `  ${p.m.member}: `)), ...(req.runVerify ? { run: req.runVerify } : {}) });
        const key = { key: verifyKey(v.steps), kind: "verify" as const, name: "verify" };
        if (!outcome.passed) {
          await write(p, key, "verify-failed", [], { step: outcome.step.name, exitCode: String(outcome.exitCode) });
          throw new TrainPublishRunError(
            "publish-verify-failed",
            p.plan.redactor.redact(`${p.m.member}: verify: ${outcome.step.name} exited ${outcome.exitCode ?? "on a signal"}`),
            "Nothing was revealed. Fix what it found and run the same command again: what staged is not staged again, and the verify commands run again before any reveal.",
            p.m.member,
            "verify",
            [...stagedNames],
            [],
          );
        }
        await write(p, key, "verified", [], {});
      }
      verified = "passed";
    }
  }

  // Pass 2: layer by layer, reveal; then wait until the layer resolves before the next one.
  const published: Array<{ member: string; targets: PublishedTarget[] }> = [];
  for (let layer = 0; layer < req.layers; layer++) {
    const inLayer = ordered.filter((p) => p.layer === layer);
    const waits: Array<{ p: Prepared; t: PublishTarget; done: PublishedTarget }> = [];
    for (const p of inLayer) {
      const progress = req.progressOfMember.get(p.m.member)!;
      const out: PublishedTarget[] = [];
      for (const t of revealOrder(p.plan.targets)) {
        const done = progress.revealed.get(t.key);
        if (done) {
          resumed.push({ member: p.m.member, target: t.name, step: "revealed" });
          say(`  ${shown(p, t)}: published by an earlier run; skipped`);
          const was = { ...done, target: t.name, destination: t.destination, items: done.items.map((i) => ({ ...i, present: true })) };
          out.push(was);
          revealedNames.push(shown(p, t));
          waits.push({ p, t, done: was });
          continue;
        }
        if (!staged.has(keyOf(p, t)) && !refused.has(keyOf(p, t))) await stage(p, t);
        const wasRefused = refused.get(keyOf(p, t));
        if (wasRefused) {
          out.push(wasRefused);
          continue;
        }
        say(`  ${p.m.member}: revealing ${t.name}`);
        let r: PublishedTarget;
        try {
          r = await t.reveal(p.ctx, staged.get(keyOf(p, t))!);
        } catch (err) {
          if (t.refusalWarns) {
            out.push(refusal(p, t, err));
            continue;
          }
          return fail(err, p, t, "reveal");
        }
        out.push(r);
        if (r.warning) {
          say(`  warning: ${shown(p, t)}: ${r.warning}`);
          continue;
        }
        revealedNames.push(shown(p, t));
        await write(p, t, "revealed", r.items, {});
        waits.push({ p, t, done: r });
      }
      published.push({ member: p.m.member, targets: out });
    }
    if (layer === req.layers - 1) continue;
    for (const { p, t, done } of waits) {
      if (!t.visible) continue;
      try {
        await t.visible(p.ctx, done);
      } catch (err) {
        return fail(err, p, t, "wait");
      }
    }
  }
  return { published, resumed, recordWarning, ...(verified ? { verified } : {}) };
}

const USAGE = "chant workspace train publish <env> [<train id|digest>] [--yes] [--allow-unsigned] [--require-provenance] [--json]";

/** `chant workspace train publish <env> [<train>] [--yes]` (#5136). */
export async function runTrainPublish(ctx: import("../cli/registry").CommandContext, words: string[]): Promise<number> {
  const { formatError, formatSuccess, formatWarning } = await import("../cli/format");
  const { WorkspaceReadError } = await import("./declaration");
  const { fetchLifecycle } = await import("../lifecycle/git");
  const { args } = ctx;
  const [env, ref] = words;
  if (!env) {
    console.error(formatError({ message: "chant workspace train publish needs an environment", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  const json = args.json === true;
  await fetchLifecycle({ cwd }).catch(() => false);
  let outcome: TrainPublishOutcome;
  try {
    outcome = await publishTrain({
      cwd,
      env,
      ...(ref !== undefined ? { train: ref } : {}),
      yes: args.yes === true && args.dryRun !== true,
      allowUnsigned: args.allowUnsigned === true,
      requireProvenance: args.requireProvenance === true,
      say: (line) => (json ? undefined : console.error(line)),
      log: (line) => (json ? undefined : console.error(`    ${line}`)),
    });
  } catch (err) {
    if (err instanceof WorkspaceReadError) {
      console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: USAGE }));
      return 1;
    }
    if (err instanceof TrainPublishRunError) {
      const where =
        (err.step === "stage" || err.step === "verify") && err.revealed.length === 0
          ? `nothing is visible yet${err.staged.length > 0 ? `; staged: ${err.staged.join(", ")}` : ""}`
          : `revealed: ${err.revealed.length > 0 ? err.revealed.join(", ") : "none"}; staged and not yet revealed: ${err.staged.filter((t) => !err.revealed.includes(t)).join(", ") || "none"}`;
      if (json) console.log(JSON.stringify({ status: "failed", code: err.code, message: err.message, member: err.member, step: err.step, staged: err.staged, revealed: err.revealed }, null, 2));
      console.error(formatError({ message: `${err.message}; ${where} [${err.code}]`, hint: `${err.fix ? `${err.fix} ` : ""}Run the same command again to resume; what went out is not published again.` }));
      return 1;
    }
    throw err;
  }
  if (outcome.kind === "refused") {
    if (json) console.log(JSON.stringify({ status: "refused", code: outcome.code, message: outcome.message }, null, 2));
    console.error(formatError({ message: `${outcome.message} [${outcome.code}]`, ...(outcome.fix ? { hint: outcome.fix } : {}) }));
    return 1;
  }
  const { redactor } = outcome;
  for (const w of outcome.warnings) console.error(formatWarning({ message: w }));
  const base = { train: outcome.train.id, trainDigest: outcome.train.trainDigest, env, members: outcome.members };
  if (outcome.kind === "planned") {
    if (json) {
      console.log(redactor.redact(JSON.stringify({ dryRun: true, ...base, ...(outcome.verify.length > 0 ? { verify: outcome.verify } : {}) }, null, 2)));
      return 0;
    }
    const out = (line: string) => console.log(redactor.redact(line));
    out(`Dry run: publish release train ${outcome.train.id} (${outcome.train.trainDigest}) for ${env}`);
    for (const m of outcome.members) {
      if (m.role === "pinned") {
        out(`  ${m.member} ${m.label ?? m.releaseDigest}: pinned at commit ${m.commit.slice(0, 12)}, already published`);
        continue;
      }
      out(`  layer ${m.layer}: ${m.member} ${m.label ?? m.releaseDigest}${m.after ? `, after ${m.after.join(", ")}` : ""}`);
      for (const t of m.targets) {
        const earlier = t.progress === "revealed" ? " (published by an earlier run; skipped)" : t.progress === "staged" ? " (staged by an earlier run; only revealed)" : "";
        out(`    ${t.name}${earlier}:`);
        for (const i of t.items) out(`      ${i.name} to ${i.destination}`);
      }
    }
    for (const v of outcome.verify) {
      out(`  verify ${v.member}, after every member has staged and before the first layer reveals:`);
      for (const s of v.steps) out(`    ${s.name === s.run ? s.run : `${s.name}: ${s.run}`}`);
    }
    console.error(`Dry run: nothing was published. Run again with --yes to publish.`);
    return 0;
  }
  if (outcome.recordWarning) console.error(formatWarning({ message: redactor.redact(`${outcome.recordWarning}. A resume asks the registries what is already there.`) }));
  for (const w of outcome.floatingWarnings ?? []) console.error(formatWarning({ message: redactor.redact(w) }));
  if (json) {
    console.log(redactor.redact(JSON.stringify({ dryRun: false, ...base, published: outcome.published, resumed: outcome.resumed, ...(outcome.verified ? { verified: outcome.verified } : {}) }, null, 2)));
    return 0;
  }
  const count = outcome.members.filter((m) => m.role === "publish").length;
  console.error(formatSuccess(`Published release train ${outcome.train.id}: ${count} member release(s), layer by layer`));
  return 0;
}
