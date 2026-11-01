/**
 * Cutting a release from a green commit (#4026, ws-104).
 *
 * The cut takes the checkout's `HEAD`, refuses it unless it carries a
 * `ci/green/<sha>` tag and no `ci/revoked/<sha>` tag (ws-103, read from local
 * tags), and refuses a working tree with uncommitted changes to tracked
 * files, since the compile would then not be the commit's. It compiles every
 * environment the member declares, in its promotion order (#4030), and
 * refuses a component whose build steps differ between environments, since
 * "built once" can't hold for it. It then builds each component's artifacts
 * once, stores the release and appends the cut.
 *
 * An artifact whose source did not change since the earlier release cut
 * from the nearest ancestor commit is not built again: the release carries that
 * release's entry, so a config-only release keeps the same artifact digests.
 * "Did not change" means git sees no change between the two commits in the
 * component's own file, the member's `chant.config.ts` and the paths its
 * build steps read.
 *
 * A project with no components (#4046) needs no special case here: its
 * targets hold the files `chant build --env <env>` writes, each with
 * `component: null`, and `artifactDigests` is empty.
 *
 * Compiling goes through a {@link TargetCompiler}, so a test hands the cut
 * fixtures and the CLI hands it child processes.
 *
 * Who may cut (#4031): when the declaration at base names a `release` gate
 * in `identity.gates`, a cut must be signed (`--sign`), its signature must
 * verify for the actor against the signers at base, and when the gate names
 * a class the actor must be in it. A cut signed without that gate is signed
 * all the same, and readers report whether the signature verifies. With
 * `ci.green.signedSince` declared, a green tag counts only with a valid
 * statement (`../workspace/ci-green.ts`), so a hand-pushed tag cuts nothing.
 *
 * A lane (#4692): a cut given a lane `ci.green.lanes` declares checks that
 * lane's tags, `ci/green-<lane>/<sha>` and `ci/revoked-<lane>/<sha>`, in place
 * of `ci/green/<sha>` and `ci/revoked/<sha>`, and the cut line names the lane.
 *
 * An override (#4693): a commit with no green tag that counts is cut when the
 * cut asks for it (`overrideGreen`) and a person's override of it stands on
 * the override ledger, `_gates/policy-override.jsonl` (`../override-gate.ts`).
 * The subject is `release-<sha12>`, the plan the commit, and the rule
 * `ci-green` (or `ci-green-<lane>`). It counts when a person the overriders
 * file at base lists wrote it with a reason, sealed under a `release` gate in
 * `identity.gates`. The cut spends it and records it on the cut line. With no
 * override that counts, a cut (not a dry run) records the request for one,
 * which `chant approve policy-override` answers. A revoked commit is never
 * cut, override or not.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalJson } from "../effect-receipt";
import { getHeadCommit } from "./git";
import { resolveMemberLedger } from "./member-ledger";
import { resolveCiRun } from "./release-ledger";
import {
  appendCut,
  invalidLabel,
  labelsByDigest,
  makeRelease,
  persistRelease,
  readAllReleases,
  readCuts,
  readRelease,
  ReleaseLabelError,
  type Release,
  type ReleaseArtifact,
  type ReleaseCut,
  type ReleaseCutOverride,
  type ReleaseTarget,
  templateBytesDigest,
  type TemplateContent,
} from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant that cuts from a lane's green tag and writes `lane` on the cut line (#4692). */
export const RELEASE_CUT_LANE_FLOOR = NEXT_RELEASE;
/** The first chant that cuts a commit that is not green under an override and writes `override` on the cut line (#4693). */
export const RELEASE_CUT_OVERRIDE_FLOOR = NEXT_RELEASE;

/** The override gate's subject for a cut of `commit` (#4693): `release-<sha12>`. */
export function greenOverrideSubject(commit: string): string {
  return `release-${commit.slice(0, 12)}`;
}

/** The rule an override of a cut names (#4693): `ci-green`, or `ci-green-<lane>` for a lane's tag. */
export function greenOverrideRule(lane: string | null): string {
  return lane !== null ? `ci-green-${lane}` : "ci-green";
}

/** How long a recorded request for an override stands before a cut records a fresh one. */
const OVERRIDE_REQUEST_HOURS = 48;

/** The stable codes a cut refuses with. */
export type ReleaseCutCode =
  | "not-a-git-repository"
  | "release-commit-not-green"
  | "release-commit-revoked"
  | "release-worktree-dirty"
  | "release-no-environments"
  | "release-no-components"
  | "release-build-inputs-differ"
  | "release-unsigned"
  | "release-signer-refused"
  | "declaration-invalid";

export class ReleaseCutError extends Error {
  constructor(
    readonly code: ReleaseCutCode,
    message: string,
    readonly fix?: string,
    /** The cut recorded a request for an override on `chant/lifecycle` (#4693), which the caller pushes. */
    readonly recorded = false,
  ) {
    super(message);
    this.name = "ReleaseCutError";
  }
}

export interface CutRequest {
  /** The member's directory. */
  cwd: string;
  compiler: TargetCompiler;
  /** The label, or null to cut without one. */
  label: string | null;
  actor: string;
  /** The environments in promotion order. Read from the member's `chant.config.ts` when absent. */
  environments?: readonly string[];
  now?: () => Date;
  /** The process environment the CI run is read from. */
  env?: NodeJS.ProcessEnv;
  /**
   * Sign the cut (#4031): an ssh key file, or true for git's
   * `user.signingkey`, as `chant approve --sign` takes it. The signature is
   * over the release digest, the label, the actor and the time, and `actor`
   * must be the principal the signers file lists the key for.
   */
  sign?: string | true;
  /** The composition of a composed commit (#4168 4.3), recorded on the cut. */
  composed?: { branch: string; base: string; sources: string[] };
  /** The publish channel recorded on the cut (#4168 4.3), in place of `latest`. */
  channel?: string;
  /**
   * The green lane to check (#4692), one `ci.green.lanes` declares at base:
   * the commit must carry `ci/green-<lane>/<sha>` and no
   * `ci/revoked-<lane>/<sha>`. Recorded on the cut. Absent, the full
   * `ci/green/<sha>` tag is checked.
   */
  lane?: string;
  /**
   * Cut the commit when it has no green tag that counts, under a person's
   * override of it (#4693). Without an override that counts the cut is
   * refused, and a cut that is not a dry run records the request for one.
   */
  overrideGreen?: boolean;
}

export interface CutResult {
  release: Release;
  /** The cut line written, or null when this digest was already cut. */
  cut: ReleaseCut | null;
  /** The release's label after the cut. */
  label: string | null;
  /** Whether the release file was written now, rather than already stored. */
  stored: boolean;
  /** The components whose artifacts were taken from an earlier release, and that release's digest. */
  reused: Array<{ component: string; from: string }>;
}

function git(top: string, args: string[]): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(top: string, args: string[]): string | null {
  try {
    return git(top, args);
  } catch {
    return null;
  }
}

/**
 * Whether `sha` has a green tag and no revoked tag, read from local tags,
 * and the tags on it that were ignored for want of a valid statement
 * (#4031). The tags are judged by `green`, the declaration's `ci.green` at
 * base, with the runner keys read at its branch's tip; with no `ci.green`,
 * every tag counts. With `lane` (#4692), that lane's tags are read.
 */
export async function greenState(
  top: string,
  sha: string,
  green: import("../workspace/declaration").CiGreen | null = null,
  lane?: string,
): Promise<{ state: "green" | "revoked" | "none"; ignored: Array<{ tag: string; status: string; reason: string }> }> {
  const { judgedCiTags } = await import("./release-revocation");
  let tags: Awaited<ReturnType<typeof judgedCiTags>>;
  try {
    tags = await judgedCiTags(top, green, lane);
  } catch (err) {
    const { WorkspaceReadError } = await import("../workspace/declaration");
    if (err instanceof WorkspaceReadError) throw new ReleaseCutError("declaration-invalid", err.message);
    throw err;
  }
  const ignored = tags.ignored.get(sha) ?? [];
  if (tags.revoked.has(sha)) return { state: "revoked", ignored };
  return { state: tags.green.has(sha) ? "green" : "none", ignored };
}

/** Which components' build steps differ between environments, with the environments they appear in. */
export function differingBuildSteps(targets: readonly CompiledTarget[]): Array<{ component: string; envs: string[] }> {
  const byComponent = new Map<string, Map<string, string>>();
  for (const t of targets) {
    for (const [component, steps] of Object.entries(t.buildSteps)) {
      if (!byComponent.has(component)) byComponent.set(component, new Map());
      byComponent.get(component)!.set(t.env, canonicalJson(steps));
    }
  }
  const out: Array<{ component: string; envs: string[] }> = [];
  for (const [component, perEnv] of byComponent) {
    if (new Set(perEnv.values()).size > 1) out.push({ component, envs: [...perEnv.keys()] });
  }
  return out.sort((a, b) => (a.component < b.component ? -1 : 1));
}

/** The earlier release of this member cut from the nearest ancestor of `commit`. */
async function previousRelease(top: string, commit: string, cwd: string): Promise<Release | undefined> {
  const { releases } = await readAllReleases({ cwd });
  const { cuts } = await readCuts({ cwd });
  const cutAt = new Map<string, string>();
  for (const c of cuts) if (!cutAt.has(c.releaseDigest) || c.timestamp > cutAt.get(c.releaseDigest)!) cutAt.set(c.releaseDigest, c.timestamp);
  const candidates = releases
    .filter((r) => cutAt.has(r.releaseDigest) && r.commit !== commit)
    .filter((r) => tryGit(top, ["merge-base", "--is-ancestor", r.commit, commit]) !== null)
    .map((r) => ({ r, depth: Number(tryGit(top, ["rev-list", "--count", r.commit]) ?? 0), at: cutAt.get(r.releaseDigest)! }))
    // The nearest ancestor first, then the newest cut of it.
    .sort((a, b) => b.depth - a.depth || (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
  return candidates[0]?.r;
}

/** What every cut and every dry run reads and compiles before it decides. */
interface Prepared {
  cwd: string;
  commit: string;
  envs: readonly string[];
  compiled: CompiledTarget[];
  releaseRule: ReturnType<typeof import("../workspace/identity").releaseRuleFrom>;
  /** The components to build, by the environment they are built in. */
  toBuild: Map<string, string[]>;
  /** The artifacts carried from an earlier release. */
  carried: ReleaseArtifact[];
  reused: CutResult["reused"];
  member: string | null;
  /** The lane the commit was checked in, or null for the full green tag. */
  lane: string | null;
  /** The override the commit is cut under when it is not green (#4693), or null. */
  override: ReleaseCutOverride | null;
}

/**
 * Decide the override of a cut of `commit`, which has no green tag that
 * counts (#4693), as `decideOverride` decides any: against the overriders
 * file and, when `sealed`, the signers at base. With none that counts and
 * `record`, the request for one is appended unless one stands.
 */
async function greenOverride(req: {
  top: string;
  cwd: string;
  commit: string;
  lane: string | null;
  sealed: boolean;
  record: boolean;
  now: string;
}): Promise<{ override: Omit<ReleaseCutOverride, "green" | "tag"> } | { override: null; why: string; fix: string; recorded: boolean }> {
  const og = await import("../override-gate");
  const { readOverrideLedger, recordOverrideDenial } = await import("./override-ledger");
  const { resolveBase } = await import("../workspace/trust/provenance");
  const subject = greenOverrideSubject(req.commit);
  const rules = [greenOverrideRule(req.lane)];
  const base = resolveBase(req.top).commit;
  const overriders = base ? og.overridersAt(req.top, base) : null;
  const signers = req.sealed && base ? (await import("../gate-decision")).gateSignersAt(req.top, base) : undefined;
  const ledger = await readOverrideLedger({ cwd: req.cwd });
  const verdict = og.decideOverride({
    ledger,
    applied: ledger.applied,
    subject,
    planDigest: req.commit,
    rules,
    overriders: overriders?.principals ?? [],
    mode: req.sealed ? "sealed" : "ledger",
    ...(signers ? { signers } : {}),
    now: req.now,
  });
  if (verdict.status === "overridden") {
    const o = verdict.override;
    return { override: { by: o.by, at: o.at, reason: o.reason, digest: o.digest, sealed: o.sealed } };
  }
  let recorded = false;
  if (req.record && !verdict.standing) {
    await recordOverrideDenial(
      {
        subject,
        planDigest: req.commit,
        rules,
        timestamp: req.now,
        expiresAt: new Date(Date.parse(req.now) + OVERRIDE_REQUEST_HOURS * 3_600_000).toISOString(),
        description: `release cut of commit ${req.commit.slice(0, 12)}, which has no ${req.lane !== null ? `ci/green-${req.lane}` : "ci/green"} tag that counts`,
      },
      { cwd: req.cwd },
    );
    recorded = true;
  }
  const notes = [
    ...verdict.refusals.map((r) => `an override does not count: ${r}`),
    ...(verdict.status === "moved" ? [`${verdict.by} overrode another commit or rule (${verdict.was ?? "no digest"}), which counts for nothing here`] : []),
    recorded
      ? `the request for an override of ${subject} is recorded on chant/lifecycle`
      : verdict.standing
        ? `the request for an override of ${subject} has stood since ${verdict.standing.timestamp}`
        : `a cut with --yes records the request for an override of ${subject}`,
  ];
  const who = !overriders?.active
    ? `${og.OVERRIDERS_PATH} at base does not exist, so nobody may override it yet. Once it lists a person, they may`
    : overriders.principals.length > 0
      ? `${overriders.principals.join(", ")} may`
      : `${og.OVERRIDERS_PATH} at base lists nobody, so nobody may`;
  return {
    override: null,
    why: notes.join("; "),
    fix: `${who} override it with: ${og.overrideCommand(subject, rules, req.sealed)}, and then cut again with --override-green.`,
    recorded,
  };
}

/**
 * The lane `name` as the declaration at base declares it (#4692), or a
 * `declaration-invalid` refusal when there is no `ci.green` or it declares
 * no such lane.
 */
async function declaredLane(green: import("../workspace/declaration").CiGreen | null, name: string): Promise<string> {
  if (!green) {
    throw new ReleaseCutError("declaration-invalid", `the cut asks for lane ${JSON.stringify(name)}, and chant.workspace.json at base declares no ci.green, so it has no lanes`);
  }
  const { laneOf, WorkspaceReadError } = await import("../workspace/declaration");
  try {
    return laneOf(green, name).name;
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw new ReleaseCutError("declaration-invalid", err.message);
    throw err;
  }
}

/**
 * The checks and the compile a cut makes before it builds or writes: the
 * commit is green and not revoked, the cut is signed when the release gate
 * asks, the tree is clean, every environment compiles with the same build
 * steps, and which artifacts are carried from an earlier release.
 */
async function prepare(req: CutRequest, record = false): Promise<Prepared> {
  const cwd = resolve(req.cwd);
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new ReleaseCutError("not-a-git-repository", "a release is cut from a commit, and this directory is not in a git repository");
  const commit = await getHeadCommit({ cwd });

  // #4031: the declaration at base says whether tags need a statement and who may cut.
  const { scopeSource } = await import("../workspace/write-scope");
  const { releaseRuleFrom } = await import("../workspace/identity");
  const source = scopeSource(cwd);
  const green = source.declaration?.ci?.green ?? null;
  const lane = req.lane !== undefined ? await declaredLane(green, req.lane) : null;
  const { state, ignored } = await greenState(top, commit, green, lane ?? undefined);
  // Who may cut is the declaration's identity.gates.release, read at base.
  const releaseRule = releaseRuleFrom(source);
  let override: ReleaseCutOverride | null = null;
  if (state !== "green") {
    const why = ignored.length > 0 ? `; ignored: ${ignored.map((t) => `${t.tag} (${t.status}): ${t.reason}`).join("; ")}` : "";
    // #4692: a lane's tags are ci/green-<lane>/ and ci/revoked-<lane>/.
    const greenTag = lane !== null ? `ci/green-${lane}` : "ci/green";
    const revokedTag = lane !== null ? `ci/revoked-${lane}` : "ci/revoked";
    const message =
      state === "revoked"
        ? `commit ${commit.slice(0, 12)} has a ${revokedTag} tag: it went red after it was green, so no release is cut from it`
        : ignored.some((t) => t.tag.startsWith(`${greenTag}/`))
          ? `commit ${commit.slice(0, 12)} has no ${greenTag} tag that counts, so no release is cut from it${why}`
          : `commit ${commit.slice(0, 12)} has no ${greenTag} tag, so no release is cut from it`;
    const fix = `Check out a green commit (\`chant ci last-green${lane !== null ? ` --lane ${lane}` : ""}\` names the newest) after fetching the tags: git fetch origin --tags`;
    if (state === "revoked") {
      throw new ReleaseCutError("release-commit-revoked", req.overrideGreen ? `${message}, and an override does not cut a revoked commit` : message, fix);
    }
    if (!req.overrideGreen) throw new ReleaseCutError("release-commit-not-green", message, fix);
    // #4693: a person's override of this commit lets it through.
    const now = (req.now ?? (() => new Date()))().toISOString();
    const decided = await greenOverride({ top, cwd, commit, lane, sealed: releaseRule.requirement !== null, record, now });
    if (decided.override === null) throw new ReleaseCutError("release-commit-not-green", `${message}; ${decided.why}`, decided.fix, decided.recorded);
    override = { green: false, tag: `${greenTag}/${commit}`, ...decided.override };
  }
  if (releaseRule.requirement && req.sign === undefined) {
    throw new ReleaseCutError(
      "release-unsigned",
      `chant.workspace.json at base names a release gate in identity.gates${releaseRule.requirement.class !== null ? `, from the class ${releaseRule.requirement.class}` : ""}, and this cut is not signed`,
      `chant release cut <label> --actor <principal> --sign [<key file>], with a key ${releaseRule.rule.signers.signersPath} at base lists for that principal.`,
    );
  }
  const dirty = tryGit(top, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new ReleaseCutError(
      "release-worktree-dirty",
      `the working tree has uncommitted changes to tracked files, so a compile here would not be commit ${commit.slice(0, 12)}'s`,
      "Commit or stash them, or cut from a clean checkout of the commit.",
    );
  }

  let envs = req.environments;
  if (!envs) {
    const { readMemberPromotionOrder } = await import("../workspace/promotion-order");
    envs = ((await readMemberPromotionOrder(cwd)) ?? []).map((s) => s.name);
  }
  if (envs.length === 0) {
    throw new ReleaseCutError(
      "release-no-environments",
      "this member's chant.config.ts declares no environments, so there is nothing to compile a release for",
      "Declare them in promotion order: environments: [\"dev\", \"staging\", \"prod\"]",
    );
  }

  const compiled: CompiledTarget[] = [];
  for (const env of envs) compiled.push(await req.compiler.compile(env));

  // A project with no components compiles to its build output (#4046), so only a target with neither is empty.
  if (compiled.every((t) => t.components.length === 0 && t.templates.length === 0)) {
    throw new ReleaseCutError(
      "release-no-components",
      "no component is enabled in any environment and nothing was compiled, so there is nothing to release",
      "Enable a component under one environment's parameters, or remove the component files so the project's build output is released.",
    );
  }
  const differing = differingBuildSteps(compiled);
  if (differing.length > 0) {
    throw new ReleaseCutError(
      "release-build-inputs-differ",
      `the build steps of ${differing.map((d) => `"${d.component}"`).join(", ")} differ between environments (${[...new Set(differing.flatMap((d) => d.envs))].join(", ")}), ` +
        "so their artifacts can't be built once for every environment",
      "Make the build steps read no environment-specific value; pass the value to a deploy step instead.",
    );
  }

  // Which environment each component's artifacts are built in: the first one it is enabled in.
  const firstEnv = new Map<string, CompiledTarget>();
  for (const t of compiled) for (const c of t.components) if (!firstEnv.has(c) && (t.buildSteps[c]?.length ?? 0) > 0) firstEnv.set(c, t);

  // git names paths from its top with symlinks resolved (/private/var on macOS).
  const realCwd = realpathSync(cwd);
  const previous = firstEnv.size > 0 ? await previousRelease(top, commit, cwd) : undefined;
  const reused: CutResult["reused"] = [];
  const artifacts: ReleaseArtifact[] = [];
  const toBuild = new Map<string, string[]>();
  for (const [component, target] of firstEnv) {
    const prior = previous?.artifactDigests.filter((a) => a.component === component) ?? [];
    if (previous && prior.length > 0) {
      const paths = [target.componentFiles[component], "chant.config.ts", ...(target.buildInputs[component] ?? [])]
        .filter((p): p is string => typeof p === "string")
        .map((p) => relative(top, resolve(realCwd, p)))
        .filter((p) => p !== "" && !p.startsWith(".."));
      // With no path to compare, the source can't be shown unchanged, so it is built.
      const changed = paths.length === 0 ? null : tryGit(top, ["diff", "--name-only", previous.commit, commit, "--", ...paths]);
      if (changed === "") {
        artifacts.push(...prior);
        reused.push({ component, from: previous.releaseDigest });
        continue;
      }
    }
    toBuild.set(target.env, [...(toBuild.get(target.env) ?? []), component]);
  }
  const ledger = await resolveMemberLedger(cwd);
  return {
    cwd,
    commit,
    envs,
    compiled,
    releaseRule,
    toBuild,
    carried: artifacts,
    reused,
    member: ledger.members.length > 0 ? ledger.members.join("/") : null,
    lane,
    override,
  };
}

/**
 * The targets and template bytes of a compile, each template by its content
 * digest. A compile of components names its directories in `trees` (#4155),
 * an empty list when it has none, which marks the target as one that records
 * every deploy input. A project with no components has no deploy step to
 * name one, and its targets have no `trees`.
 */
function targetsOf(compiled: readonly CompiledTarget[]): { targets: ReleaseTarget[]; templates: TemplateContent[] } {
  const templates: TemplateContent[] = [];
  const targets: ReleaseTarget[] = compiled.map((t) => {
    const seen = new Set<string>();
    const recorded: ReleaseTarget["templates"] = [];
    for (const tpl of t.templates) {
      // A file named twice, as a values file inside a recorded chart, is recorded once.
      const key = `${tpl.component ?? ""}\u0000${tpl.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const digest = templateBytesDigest(tpl.content, tpl.encoding);
      templates.push({ digest, content: tpl.content, ...(tpl.encoding ? { encoding: tpl.encoding } : {}) });
      recorded.push({ component: tpl.component, path: tpl.path, digest, ...(tpl.encoding ? { encoding: tpl.encoding } : {}) });
    }
    return { env: t.env, params: t.params, templates: recorded, ...(t.trees ? { trees: t.trees } : {}) };
  });
  return { targets, templates };
}

/** What a dry run of the cut found (#4027): what the cut would do, with nothing built, signed or written. */
export interface CutPlan {
  commit: string;
  member: string | null;
  label: string | null;
  /** The release's digest when no artifact needs building, so it is known now; null when a build decides it. */
  releaseDigest: string | null;
  /** The digest already cut under `label`, or this digest when it is already cut: the cut would then write no new release. */
  alreadyCut: string | null;
  /** Each environment's target: its params, and its templates by component and path. */
  targets: Array<{ env: string; params: ReleaseTarget["params"]; templates: Array<{ component: string | null; path: string }>; trees?: ReleaseTarget["trees"] }>;
  /** The components whose artifacts would be built, and the environment each is built in. */
  build: Array<{ component: string; env: string }>;
  /** The components whose artifacts would be carried from an earlier release. */
  reused: CutResult["reused"];
  /** Each component's publish steps, with the environments whose deploy runs them. */
  publishSteps: Array<{ component: string; kind: string; to: string | null; envs: string[] }>;
  /** Whether the release gate in identity.gates requires a signed cut. */
  signatureRequired: boolean;
  /** The green lane the commit was checked in (#4692), or null for the full green tag. */
  lane: string | null;
  /** The override the cut would run under and spend (#4693), when the commit is not green; null when it is. */
  override: ReleaseCutOverride | null;
}

/**
 * The dry run of {@link cutRelease} (#4027): the same checks and compile,
 * then what the cut would build, carry and record, without building an
 * artifact, signing, or writing anything. Throws what the cut throws before
 * it builds, and `ReleaseLabelError` when the label is invalid or names a
 * release of another commit.
 */
export async function planRelease(req: CutRequest): Promise<CutPlan> {
  const p = await prepare(req);
  const { targets } = targetsOf(p.compiled);
  const build: CutPlan["build"] = [];
  for (const env of p.envs) for (const component of p.toBuild.get(env) ?? []) build.push({ component, env });
  const releaseDigest = build.length === 0 ? makeRelease({ member: p.member, commit: p.commit, artifactDigests: p.carried, targets }).releaseDigest : null;

  const { cuts } = await readCuts({ cwd: p.cwd });
  const labels = labelsByDigest(cuts);
  let alreadyCut: string | null = null;
  if (req.label !== null) {
    const why = invalidLabel(req.label);
    if (why) throw new ReleaseLabelError("release-label-invalid", why);
    const named = [...labels].find(([, l]) => l === req.label)?.[0];
    if (named !== undefined) {
      const other = await readRelease(named, { cwd: p.cwd });
      const sameCommit = other?.commit === p.commit;
      if (!sameCommit || (releaseDigest !== null && named !== releaseDigest)) {
        throw new ReleaseLabelError(
          "release-label-taken",
          `the label "${req.label}" already names release ${named}${other && !sameCommit ? `, cut from commit ${other.commit.slice(0, 12)}` : ""}`,
        );
      }
      alreadyCut = named;
    }
  }
  if (releaseDigest !== null && alreadyCut === null && cuts.some((c) => c.releaseDigest === releaseDigest)) {
    const own = labels.get(releaseDigest);
    if (own !== undefined && req.label !== null && own !== req.label) {
      throw new ReleaseLabelError("release-already-labelled", `release ${releaseDigest} is already labelled "${own}", and a release takes one label`);
    }
    alreadyCut = releaseDigest;
  }

  const steps = new Map<string, CutPlan["publishSteps"][number]>();
  for (const t of p.compiled) {
    for (const [component, list] of Object.entries(t.publishSteps ?? {})) {
      for (const step of list as Array<{ kind?: unknown; to?: unknown }>) {
        const kind = typeof step.kind === "string" ? step.kind : "publish";
        const to = typeof step.to === "string" ? step.to : null;
        const key = JSON.stringify([component, kind, to]);
        const entry = steps.get(key) ?? { component, kind, to, envs: [] };
        if (!entry.envs.includes(t.env)) entry.envs.push(t.env);
        steps.set(key, entry);
      }
    }
  }

  return {
    commit: p.commit,
    member: p.member,
    label: req.label,
    releaseDigest,
    alreadyCut,
    targets: targets.map((t) => ({ env: t.env, params: t.params, templates: t.templates.map(({ component, path }) => ({ component, path })), ...(t.trees ? { trees: t.trees } : {}) })),
    build,
    reused: p.reused,
    publishSteps: [...steps.values()],
    signatureRequired: p.releaseRule.requirement !== null,
    lane: p.lane,
    override: p.override,
  };
}

/**
 * Cut a release of the member at `req.cwd` from its checkout's `HEAD`. Writes
 * the release and the cut to the local `chant/lifecycle` branch and does not
 * push. Throws {@link ReleaseCutError} before anything is written when the
 * commit isn't green, the tree is dirty, or an environment can't be compiled
 * to the same artifacts, and `ReleaseLabelError` (./release-store.ts) when the
 * label is taken or the release already carries another one. The one write
 * before a refusal is the request for an override (#4693), when the cut asks
 * for one and none stands; the error's `recorded` says so.
 *
 * The cut line names its run (#4027): the CI run's id and origin in CI, and
 * outside CI an id minted from the cut's time, `local-<epoch ms>`, with the
 * origin `{ forge: "local" }`.
 */
export async function cutRelease(req: CutRequest): Promise<CutResult> {
  const p = await prepare(req, true);
  const { cwd, commit, compiled, releaseRule, reused } = p;
  const artifacts = [...p.carried];
  for (const env of p.envs) {
    const names = p.toBuild.get(env);
    if (names) artifacts.push(...(await req.compiler.buildArtifacts(env, names)));
  }
  const { targets, templates } = targetsOf(compiled);
  const release = makeRelease({ member: p.member, commit, artifactDigests: artifacts, targets });
  const timestamp = (req.now ?? (() => new Date()))().toISOString();
  const signed = { releaseDigest: release.releaseDigest, label: req.label, actor: req.actor, timestamp };
  let signature: string | null = null;
  if (req.sign !== undefined) {
    const { resolveSigningKey, sealReleaseCut, SealError } = await import("../workspace/trust/seal");
    try {
      const key = resolveSigningKey(req.sign, cwd);
      try {
        signature = sealReleaseCut(key.file, signed).signature;
      } finally {
        key.cleanup();
      }
    } catch (err) {
      if (!(err instanceof SealError)) throw err;
      throw new ReleaseCutError("release-signer-refused", `no release was cut: ${err.message}`);
    }
  }
  if (releaseRule.requirement) {
    const { admitReleaseCut } = await import("../workspace/identity-gate-rule");
    const why = admitReleaseCut(releaseRule.rule, { ...signed, signature });
    if (why !== null) {
      throw new ReleaseCutError(
        "release-signer-refused",
        `no release was cut: ${why}`,
        `identity.gates.release in chant.workspace.json at base counts only a cut signed by a key ${releaseRule.rule.signers.signersPath} lists for the actor` +
          (releaseRule.requirement.class !== null ? `, who holds the role of the class ${releaseRule.requirement.class}` : "") +
          ". Pass --actor <principal> naming that signer.",
      );
    }
  }
  const stored = await persistRelease(release, templates, { cwd });
  const ci = resolveCiRun(req.env ?? process.env);
  const runId = ci?.runId ?? `local-${Date.parse(timestamp)}`;
  // #4693: the override is spent before the cut line names it, so it lets one cut through.
  if (p.override) {
    const { appliedOverride } = await import("../override-gate");
    const { recordOverridesApplied } = await import("./override-ledger");
    await recordOverridesApplied([appliedOverride({ subject: greenOverrideSubject(commit), digest: p.override.digest, at: p.override.at, by: p.override.by }, { timestamp, runId, commit })], { cwd });
  }
  const outcome = await appendCut(
    {
      releaseDigest: release.releaseDigest,
      label: req.label,
      actor: req.actor,
      timestamp,
      runId,
      runOrigin: ci?.runOrigin ?? { forge: "local" },
      signature,
      ...(req.composed ? { composed: req.composed } : {}),
      ...(req.channel ? { channel: req.channel } : {}),
      ...(p.lane !== null ? { lane: p.lane } : {}),
      ...(p.override ? { override: p.override } : {}),
    },
    { cwd },
  );
  return {
    release,
    cut: outcome.appended ? outcome.cut : null,
    label: outcome.appended ? outcome.cut.label : outcome.label,
    stored: stored.written,
    reused,
  };
}
