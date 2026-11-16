/**
 * Deprecate, yank and restore a published release (#5163):
 * `chant release deprecate|yank|restore <label|digest>`.
 *
 * A change is one status record (./release-status.ts) and what each publish
 * target does about it:
 *
 * - `deprecate` sets `deprecated`. Consumers keep resolving the release and
 *   are warned: npm marks each version with `npm deprecate`. A registry, a
 *   forge release and a formula have no deprecation, so nothing changes there.
 * - `yank` sets `yanked`. New consumers stop resolving the release: npm
 *   deprecates each version and moves the dist-tag back, the OCI target moves
 *   its moving tags back, the forge release becomes a prerelease, a draft or
 *   is deleted, and a tap's formula is reverted. "Back" is the head: the
 *   newest release of the same line that is active, not revoked and was
 *   revealed on that target. The line is the channel the release was cut
 *   for, else, for a prerelease label (#5166), its npm dist-tag (`rc`), else
 *   the stable line, so a yanked `1.4.0-rc.2` moves `rc` back to `1.4.0-rc.1`
 *   and a yanked stable release never moves `latest` onto a prerelease.
 * - `restore` sets `active` again and undoes what the target can: npm clears
 *   the message, a forge release is published again, and when the release is
 *   the head again the moving tags and the formula point at it.
 *
 * The floating tag (`release.tag.floating`, #5150), such as `v1`, is one
 * more step: a yank of the stable release it names moves it back to the
 * highest active stable release of that major, and a restore moves it
 * forward when the release is that one again. The release's own tag, as
 * `release.tag` renders it, names the forge release.
 *
 * What went out is read from the publish record (`_releases/publishes.jsonl`,
 * ./publish-record.ts), never the checkout, so a change runs from any
 * checkout of the member. A target the release was not revealed on is left
 * alone.
 *
 * The status record goes to `_releases/release-status.jsonl` with `env`
 * `_releases` and the member as `component`, and each target's actions to
 * `_releases/status-actions.jsonl`, both on `chant/lifecycle` and pushed as
 * they are written. A change that stopped part way resumes: run the same
 * command again, and the latest status record, when it already sets the same
 * status, is the change resumed, and a target with an actions line for it is
 * skipped.
 *
 * Under an `identity.gates.release` entry a change must be signed by a signer
 * in the gate's class, as a cut must (`admitReleaseStatus`).
 */

import type { LedgerLocation } from "./git";
import type { Release } from "./release-store";
import type { ReleaseStatusRecord } from "./release-status";
import type { ReleaseStatusValue } from "./release-catalog";
import { execFileSync } from "node:child_process";
import { renderFloatingTag, stableVersionOf, type MemberTags } from "./release-tag";
import { PublishTargetError, moveFloatingTag, type ForgeYankMode, type PublishDeps, type PublishItem, type PublishTarget, type StatusAction, type StatusContext, type StatusRelease } from "./release-publish";
import type { Redactor } from "./publish-credentials";
import { prereleaseOf } from "./release-prerelease";

/** The three commands and the status each sets. */
export type StatusVerb = "deprecate" | "yank" | "restore";

export const STATUS_OF: Readonly<Record<StatusVerb, ReleaseStatusValue>> = { deprecate: "deprecated", yank: "yanked", restore: "active" };

/** The file each target's actions are appended to, under `_releases/`. */
export const STATUS_ACTIONS_FILE = "status-actions.jsonl";

/** The ledger directory a status record of a cut release goes to: the release's own, `_releases`. */
export const RELEASE_STATUS_LEDGER = "_releases";

/** One line of `_releases/status-actions.jsonl`: what one target did for one status change. */
export interface StatusActionRecord {
  version: 1;
  releaseDigest: string;
  label: string | null;
  status: ReleaseStatusValue;
  /** The `timestamp` of the status record the actions carry out. */
  statusAt: string;
  /** The target's key. */
  target: string;
  kind: string;
  name: string;
  actions: StatusAction[];
  runId: string;
  timestamp: string;
}

/** Parse `status-actions.jsonl`. A line that is not a record is skipped. */
export function parseStatusActions(text: string | null): StatusActionRecord[] {
  const out: StatusActionRecord[] = [];
  for (const line of (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Partial<StatusActionRecord>;
      if (r && r.version === 1 && typeof r.releaseDigest === "string" && typeof r.statusAt === "string" && typeof r.target === "string" && Array.isArray(r.actions)) out.push(r as StatusActionRecord);
    } catch {
      // A line that is not JSON is skipped.
    }
  }
  return out;
}

/** Why a status change was refused before anything ran. */
export interface StatusRefusal {
  code: string;
  message: string;
  fix?: string;
}

/** One target of the change, as planned. */
export interface StatusTargetPlan {
  kind: string;
  name: string;
  key: string;
  destination: string;
  /** Set when the target is left alone, and why: the release was not revealed on it. */
  skip?: string;
  /** True when an earlier run of this change already acted on it. */
  done: boolean;
  /** What it would do (a dry run asks no registry, so a move is conditional on where the tag is). */
  actions: StatusAction[];
  /** The head the target's moving tags should point at, or null. */
  head: StatusRelease | null;
  /** The target and its context, for the run. Absent when skipped. The floating tag's step is a target with only `setStatus`. */
  target?: Pick<PublishTarget, "setStatus">;
  ctx?: StatusContext;
}

/** A change ready to run. */
export interface StatusPlan {
  verb: StatusVerb;
  status: ReleaseStatusValue;
  release: Release;
  label: string | null;
  member: string | null;
  /** The status record's `component`: the member, `.` outside a workspace. */
  component: string;
  /** The status the release has now, and the record that set it. */
  current: { status: ReleaseStatusValue; record?: ReleaseStatusRecord };
  /** The latest record when it already sets this status: the change is resumed under it, and nothing new is written. */
  resumes: ReleaseStatusRecord | null;
  actor: string;
  reason: string | null;
  replacement: string | null;
  forgeYank: ForgeYankMode;
  /** Whether `identity.gates.release` requires the change to be signed. */
  signed: boolean;
  targets: StatusTargetPlan[];
  /** Targets the release was revealed on that `release.publish` no longer declares, by name. */
  undeclared: string[];
  redactor: Redactor;
}

/** A change that stopped at a target. */
export class StatusRunError extends PublishTargetError {
  constructor(
    code: string,
    message: string,
    fix: string | undefined,
    readonly done: string[],
  ) {
    super(code, message, fix);
    this.name = "StatusRunError";
  }
}

/** The release key a moving tag is judged by: cuts in the order made, so the newest release is the one cut last. */
export interface Known {
  release: Release;
  label: string | null;
  firstCut: string;
  channel: string | null;
  /** The channel, else a prerelease label's npm dist-tag, else null for the stable line: what a head is chosen among. */
  line: string | null;
}

/** The line of a release cut for `channel` with `label` (#5166): the channel, else the prerelease's dist-tag, else null. */
export function lineOf(channel: string | null, label: string | null): string | null {
  return channel ?? prereleaseOf(label)?.distTag ?? null;
}

/**
 * The head of `target`: among `known` releases of `line` ({@link lineOf}), the newest whose
 * status (with `override` applied for one digest) is active, that is not
 * revoked and that the record says was revealed on the target.
 */
export function headOn(
  key: string,
  known: readonly Known[],
  line: string | null,
  statusOfDigest: (digest: string) => ReleaseStatusValue,
  revoked: (r: Release) => boolean,
  revealedOn: (digest: string, key: string) => PublishItem[] | undefined,
  tagOf: (label: string | null) => string | null,
): StatusRelease | null {
  const candidates = known
    .filter((k) => k.line === line && statusOfDigest(k.release.releaseDigest) === "active" && !revoked(k.release) && revealedOn(k.release.releaseDigest, key) !== undefined)
    .sort((a, b) => (a.firstCut < b.firstCut ? -1 : a.firstCut > b.firstCut ? 1 : 0));
  const top = candidates.at(-1);
  return top ? { releaseDigest: top.release.releaseDigest, label: top.label, releaseTag: tagOf(top.label), items: revealedOn(top.release.releaseDigest, key)! } : null;
}

/**
 * The floating tag's step (#5150), or null when the release moves none: no
 * `release.tag.floating`, a prerelease or non-version label, or a cut for a
 * channel. Among the stable releases of the same major cut with no channel
 * that are active (with this change applied), not revoked and published, the
 * highest version is where the tag belongs, as `floatingTagPlan` moves it at
 * publish. A yank moves it there when it names this release's commit; a
 * restore moves it to this release when it is that one.
 */
export function floatingTagStep(o: {
  cwd: string;
  tags: MemberTags;
  known: readonly Known[];
  release: Release;
  label: string | null;
  channel: string | null;
  statusOfDigest: (digest: string) => ReleaseStatusValue;
  revoked: (r: Release) => boolean;
  published: (digest: string) => boolean;
  /** Where the tag is now, a commit or null; the local tag after a fetch of it by default. */
  tagCommit?: (name: string) => string | null;
  /** Move the tag here and on the remote; returns a warning when it could not. */
  move?: (name: string, commit: string) => string | null;
}): (Required<Pick<PublishTarget, "setStatus">> & { name: string }) | null {
  const { tags, label } = o;
  if (label === null || o.channel !== null) return null;
  const name = renderFloatingTag(tags.template, tags.place, label);
  if (name === null) return null;
  const floatingOf = (l: string | null) => {
    if (l === null) return null;
    try {
      return renderFloatingTag(tags.template, tags.place, l);
    } catch {
      return null;
    }
  };
  const cmp = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  const best = o.known
    .filter((k) => k.channel === null && floatingOf(k.label) === name && o.statusOfDigest(k.release.releaseDigest) === "active" && !o.revoked(k.release) && o.published(k.release.releaseDigest))
    .map((k) => ({ k, v: stableVersionOf(k.label!)! }))
    .sort((a, b) => cmp(a.v, b.v))
    .at(-1)?.k;
  const ours = o.release.commit;
  const tagCommit = o.tagCommit ?? ((n: string) => localTagCommit(o.cwd, n));
  const move = o.move ?? ((n: string, commit: string) => moveFloatingTag(o.cwd, { name: n, commit, move: true, reason: null }));
  return {
    name,
    async setStatus(ctx: StatusContext): Promise<StatusAction[]> {
      if (ctx.status === "deprecated") return [{ what: `${name} unchanged: a deprecated release keeps it; yank moves it`, already: true }];
      if (ctx.status === "active" && best?.release.releaseDigest !== o.release.releaseDigest) {
        return [{ what: `${name} unchanged: ${best?.label ?? "another release"} is the highest active release of its major`, already: true }];
      }
      const to = ctx.status === "active" ? o.release : best?.release;
      const toName = ctx.status === "active" ? label : best?.label;
      if (!to) {
        return [{
          what: `${name} stays where it is`,
          refused: { code: "release-status-no-previous", message: `no other active release of the major ${label} is in was published, so ${name} has nowhere to move back to`, fix: `Cut and publish a release of that major, restore an earlier one, or delete the tag by hand: git push --delete origin refs/tags/${name}` },
        }];
      }
      const what = ctx.status === "active" ? `move ${name} to ${toName} (${to.commit.slice(0, 12)})` : `move ${name} back to ${toName} (${to.commit.slice(0, 12)}), if it names ${label}`;
      if (!ctx.apply) return [{ what }];
      const now = tagCommit(name);
      if (now === to.commit || (ctx.status === "yanked" && now !== ours)) return [{ what: `${name} names ${now ? now.slice(0, 12) : "nothing"}; not moved`, already: true }];
      const warning = move(name, to.commit);
      if (warning) throw new PublishTargetError("release-status-tag-failed", warning);
      ctx.log(`moved ${name} to ${to.commit.slice(0, 12)}`);
      return [{ what }];
    },
  };
}

/** The commit the tag `name` names, after fetching it from origin when it can; null when there is none. */
function localTagCommit(cwd: string, name: string): string | null {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    git(["fetch", "--quiet", "--force", "origin", `refs/tags/${name}:refs/tags/${name}`]);
  } catch {
    // No origin, or the remote has no such tag: the local tag is what there is.
  }
  try {
    return git(["rev-parse", "--verify", "--quiet", `refs/tags/${name}^{commit}`]);
  } catch {
    return null;
  }
}

/**
 * Resolve `ref` in the member at `cwd` and plan the change: the status
 * record it writes, or the one it resumes, and what each target would do.
 * Reads the local `chant/lifecycle` and the tags; asks no registry.
 */
export async function prepareStatusChange(req: {
  cwd: string;
  ref: string;
  verb: StatusVerb;
  actor: string;
  reason?: string;
  replacement?: string;
  forgeYank?: ForgeYankMode;
  /** Whether the change will be signed (`--sign`). */
  sign?: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: PublishDeps;
  log?: (line: string) => void;
}): Promise<StatusPlan | { refusal: StatusRefusal }> {
  const { resolveRelease, readCuts, readAllReleases, labelsByDigest } = await import("./release-store");
  const { readReleaseStatus, statusOf } = await import("./release-status");
  const { readBlobFromPath } = await import("./git");
  const { parsePublishRecords, PUBLISHES_FILE } = await import("./publish-record");
  const { scopeSource } = await import("../workspace/write-scope");
  const { releaseRuleFrom } = await import("../workspace/identity");
  const { createRedactor } = await import("./publish-credentials");
  const { cwd, ref, verb } = req;
  const loc: LedgerLocation = { cwd };
  const found = await resolveRelease(ref, loc);
  if (!found) return { refusal: { code: "release-not-found", message: `no release is labelled or digested "${ref}" in this member`, fix: "List them with: chant release list" } };
  const { release, label } = found;
  const name = label ?? release.releaseDigest;
  const status = STATUS_OF[verb];

  const { resolveMemberLedger } = await import("./member-ledger");
  const { releaseTagName } = await import("./release-workstation");
  const ledger = await resolveMemberLedger(cwd).catch(() => ({ members: [] as string[] }));
  const member = ledger.members.length > 0 ? ledger.members.join("/") : null;
  const component = member ?? ".";
  // #5150: the tag release.tag renders for a label, as the cut made it; the legacy tag when it can't be read.
  const { memberTags, renderReleaseTag } = await import("./release-tag");
  const tags = await memberTags(cwd).catch(() => null);
  const tagOf = (l: string | null): string | null => {
    if (l === null) return null;
    if (tags) {
      try {
        return renderReleaseTag(tags.template, tags.place, l);
      } catch {
        // A template this label can't fill: the legacy tag.
      }
    }
    return releaseTagName(member, l);
  };

  const statusRecords = (await readReleaseStatus(RELEASE_STATUS_LEDGER, loc)).records;
  const current = statusOf(statusRecords, component, release.releaseDigest);
  const resumes = current.record && current.status === status ? current.record : null;
  if (verb === "restore" && !current.record) {
    return { refusal: { code: "release-status-unchanged", message: `${name} was never deprecated or yanked, so there is nothing to restore`, fix: "Deprecate or yank it with chant release deprecate|yank." } };
  }
  if (verb === "deprecate" && current.status === "yanked") {
    return {
      refusal: {
        code: "release-status-yanked",
        message: `${name} is yanked, and a deprecation would leave its tags moved and its forge release withdrawn while the record says only deprecated`,
        fix: `Restore it first, then deprecate it: chant release restore ${name} --yes`,
      },
    };
  }

  const rule = releaseRuleFrom(scopeSource(cwd));
  if (rule.requirement && !req.sign && !resumes) {
    return {
      refusal: {
        code: "release-unsigned",
        message: `chant.workspace.json at base names a release gate in identity.gates${rule.requirement.class !== null ? `, from the class ${rule.requirement.class}` : ""}, and this status change is not signed`,
        fix: `chant release ${verb} ${name} --actor <principal> --sign [<key file>], with a key ${rule.rule.signers.signersPath} at base lists for that principal.`,
      },
    };
  }

  const env = req.env ?? process.env;
  let targets: PublishTarget[];
  try {
    const { releasePublishTargets } = await import("./release-publish");
    targets = await releasePublishTargets(cwd, req.deps);
  } catch (err) {
    return { refusal: { code: "publish-config-invalid", message: `the publish targets can't be read: ${err instanceof Error ? err.message : String(err)}`, fix: "Fix release.publish in chant.config.ts." } };
  }
  const redactor = createRedactor(env, targets.flatMap((t) => t.credentialEnv));

  // What each release revealed on each target, from the publish record.
  const records = parsePublishRecords(await readBlobFromPath(RELEASE_STATUS_LEDGER, PUBLISHES_FILE, loc)).records;
  const revealed = new Map<string, PublishItem[]>();
  const revealedNames = new Map<string, string>();
  for (const r of records) {
    if (r.step !== "revealed") continue;
    revealed.set(`${r.releaseDigest}\u0000${r.target}`, r.items);
    if (r.releaseDigest === release.releaseDigest) revealedNames.set(r.target, r.name);
  }
  const revealedOn = (digest: string, key: string) => revealed.get(`${digest}\u0000${key}`);

  // Every release of the member, in the order first cut, with its channel.
  const { cuts } = await readCuts(loc);
  const labels = labelsByDigest(cuts);
  const { releases } = await readAllReleases(loc);
  const known: Known[] = [];
  for (const r of releases) {
    const mine = cuts.filter((c) => c.releaseDigest === r.releaseDigest);
    if (mine.length === 0) continue;
    const firstCut = mine.map((c) => c.timestamp).sort()[0]!;
    const channel = [...mine].reverse().find((c) => c.channel)?.channel ?? null;
    const l = labels.get(r.releaseDigest) ?? null;
    known.push({ release: r, label: l, firstCut, channel, line: lineOf(channel, l) });
  }
  const channel = known.find((k) => k.release.releaseDigest === release.releaseDigest)?.channel ?? [...cuts].reverse().find((c) => c.releaseDigest === release.releaseDigest && c.channel)?.channel ?? null;
  const releaseLine = lineOf(channel, label);
  const { readRevokedCommits } = await import("./release-revocation");
  const revokedCommits = await readRevokedCommits(cwd).catch(() => new Map<string, unknown>());
  const statusOfDigest = (digest: string): ReleaseStatusValue => (digest === release.releaseDigest ? status : statusOf(statusRecords, component, digest).status);

  // A change resumed carries out the record's words, not this run's.
  const reason = resumes ? (resumes.reason ?? null) : (req.reason ?? null);
  const replacement = resumes ? (resumes.replacement ?? null) : (req.replacement ?? null);
  const forgeYank = req.forgeYank ?? "prerelease";
  const actionsDone = resumes
    ? new Set(parseStatusActions(await readBlobFromPath(RELEASE_STATUS_LEDGER, STATUS_ACTIONS_FILE, loc)).filter((a) => a.releaseDigest === release.releaseDigest && a.statusAt === resumes.timestamp).map((a) => a.target))
    : new Set<string>();

  const log = req.log ?? (() => undefined);
  const ctxFor = (revealed: PublishItem[], head: StatusRelease | null): StatusContext => ({
    cwd,
    env,
    redactor,
    log: (line) => log(redactor.redact(line)),
    provenance: { oidc: false, ci: null, reason: "a status change publishes nothing" },
    tag: channel,
    release,
    label,
    releaseTag: tagOf(label),
    status,
    reason,
    replacement,
    revealed,
    head,
    forgeYank,
    apply: false,
  });
  const planned: StatusTargetPlan[] = [];
  for (const target of targets) {
    const base = { kind: target.kind, name: target.name, key: target.key, destination: target.destination };
    const items = revealedOn(release.releaseDigest, target.key);
    if (!items) {
      planned.push({ ...base, skip: "the release was not published to it", done: false, actions: [], head: null });
      continue;
    }
    const head = headOn(target.key, known, releaseLine, statusOfDigest, (r) => revokedCommits.has(r.commit), revealedOn, tagOf);
    const ctx = ctxFor(items, head);
    const actions: StatusAction[] = target.setStatus
      ? await target.setStatus(ctx)
      : [{ what: `${target.name} unchanged`, refused: { code: "release-status-unsupported", message: `a ${target.kind} target can't deprecate, yank or restore a version`, fix: `Change ${target.destination} by hand.` } }];
    planned.push({ ...base, done: actionsDone.has(target.key), actions, head, target, ctx });
  }
  const floating = tags ? floatingTagStep({ cwd, tags, known, release, label, channel, statusOfDigest, revoked: (r) => revokedCommits.has(r.commit), published: (d) => targets.length === 0 || [...revealed.keys()].some((k) => k.startsWith(`${d}\u0000`)) }) : null;
  if (floating) {
    const ctx = ctxFor([], null);
    planned.push({ kind: "git-tag", name: `floating tag ${floating.name}`, key: `floating-tag:${floating.name}`, destination: `the git tag ${floating.name}`, done: actionsDone.has(`floating-tag:${floating.name}`), actions: await floating.setStatus(ctx), head: null, target: floating, ctx });
  }
  const declared = new Set(targets.map((t) => t.key));
  const undeclared = [...revealedNames].filter(([key]) => !declared.has(key)).map(([, n]) => n);
  return {
    verb,
    status,
    release,
    label,
    member,
    component,
    current,
    resumes,
    actor: resumes ? resumes.actor : req.actor,
    reason,
    replacement,
    forgeYank,
    signed: rule.requirement !== null,
    targets: planned,
    undeclared,
    redactor,
  };
}

/** What {@link runStatusChange} did. */
export interface StatusRun {
  /** The status record written now, or the one resumed. */
  record: ReleaseStatusRecord;
  written: boolean;
  /** Each target acted on, in the order run. */
  results: Array<{ name: string; actions: StatusAction[]; resumed: boolean }>;
  /** Why a line was not written or pushed, when one wasn't. */
  recordWarning: string | null;
}

/**
 * Carry out a planned change: write the status record (signed when `sign`
 * names a key) unless the plan resumes one, then act on each target, last
 * declared first for a yank, so a formula stops naming assets before the
 * forge release that holds them is withdrawn, and first declared first
 * otherwise. Each target's actions are recorded and pushed as it finishes.
 * Throws {@link StatusRunError}.
 */
export async function runStatusChange(
  plan: StatusPlan,
  req: { cwd: string; sign?: string | true; env?: NodeJS.ProcessEnv; now?: () => Date; say?: (line: string) => void; record?: boolean },
): Promise<StatusRun> {
  const { appendReleaseStatus } = await import("./release-status");
  const { appendLedgerLine, pushLifecycleReport } = await import("./git");
  const { resolveRunId } = await import("./release-ledger");
  const { sortedJsonReplacer } = await import("../utils");
  const say = req.say ?? (() => undefined);
  const now = req.now ?? (() => new Date());
  const keep = req.record ?? true;
  const runId = resolveRunId(undefined, req.env ?? process.env).runId;
  let recordWarning: string | null = null;
  const push = async () => {
    const p = await pushLifecycleReport({ cwd: req.cwd });
    if (p.pushWarning && recordWarning === null) recordWarning = p.pushWarning;
  };

  let record = plan.resumes;
  let written = false;
  if (!record) {
    const timestamp = now().toISOString();
    let signature: string | undefined;
    if (req.sign !== undefined) {
      const { resolveSigningKey, sealReleaseStatus, SealError } = await import("../workspace/trust/seal");
      try {
        const key = resolveSigningKey(req.sign, req.cwd);
        try {
          signature = sealReleaseStatus(key.file, { releaseDigest: plan.release.releaseDigest, label: plan.label, actor: plan.actor, timestamp, status: plan.status }).signature;
        } finally {
          key.cleanup();
        }
      } catch (err) {
        if (!(err instanceof SealError)) throw err;
        throw new StatusRunError("release-signer-refused", `nothing was changed: ${err.message}`, undefined, []);
      }
    }
    if (plan.signed) {
      const { scopeSource } = await import("../workspace/write-scope");
      const { releaseRuleFrom } = await import("../workspace/identity");
      const { admitReleaseStatus } = await import("../workspace/identity-gate-rule");
      const rule = releaseRuleFrom(scopeSource(req.cwd));
      const why = admitReleaseStatus(rule.rule, { releaseDigest: plan.release.releaseDigest, label: plan.label, actor: plan.actor, timestamp, status: plan.status, signature: signature ?? null });
      if (why !== null) {
        throw new StatusRunError(
          "release-signer-refused",
          `nothing was changed: ${why}`,
          `identity.gates.release in chant.workspace.json at base counts only a change signed by a key ${rule.rule.signers.signersPath} lists for the actor${rule.requirement?.class ? `, who holds the role of the class ${rule.requirement.class}` : ""}. Pass --actor <principal> naming that signer.`,
          [],
        );
      }
    }
    const input = {
      component: plan.component,
      env: RELEASE_STATUS_LEDGER,
      digest: plan.release.releaseDigest,
      ...(plan.label ? { releaseVersion: plan.label } : {}),
      status: plan.status,
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.replacement ? { replacement: plan.replacement } : {}),
      actor: plan.actor,
      timestamp,
      ...(signature ? { signature } : {}),
    };
    if (keep) {
      record = (await appendReleaseStatus(input, { cwd: req.cwd })).record;
      await push();
    } else {
      record = { version: 1, ...input };
    }
    written = true;
  }

  const order = plan.verb === "yank" ? [...plan.targets].reverse() : plan.targets;
  const results: StatusRun["results"] = [];
  const done: string[] = [];
  for (const t of order) {
    if (t.skip || !t.target || !t.ctx) continue;
    if (t.done) {
      say(`  ${t.name}: done by an earlier run; skipped`);
      results.push({ name: t.name, actions: [], resumed: true });
      done.push(t.name);
      continue;
    }
    let actions: StatusAction[];
    if (!t.target.setStatus) {
      actions = t.actions;
    } else {
      say(`  ${t.name}`);
      try {
        actions = await t.target.setStatus({ ...t.ctx, apply: true });
      } catch (err) {
        const e = err instanceof PublishTargetError ? err : new PublishTargetError("release-status-failed", err instanceof Error ? err.message : String(err));
        throw new StatusRunError(e.code, plan.redactor.redact(`${t.name}: ${e.message}`), e.fix, done);
      }
    }
    results.push({ name: t.name, actions, resumed: false });
    done.push(t.name);
    if (!keep) continue;
    try {
      const line: StatusActionRecord = {
        version: 1,
        releaseDigest: plan.release.releaseDigest,
        label: plan.label,
        status: plan.status,
        statusAt: record.timestamp,
        target: t.key,
        kind: t.kind,
        name: t.name,
        actions,
        runId,
        timestamp: now().toISOString(),
      };
      await appendLedgerLine(RELEASE_STATUS_LEDGER, STATUS_ACTIONS_FILE, plan.redactor.redact(JSON.stringify(line, sortedJsonReplacer)), `Release status actions: ${t.name}`, { cwd: req.cwd });
      await push();
    } catch (err) {
      recordWarning ??= `the status actions record was not written: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { record, written, results, recordWarning };
}
