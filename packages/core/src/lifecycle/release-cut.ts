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
  type ReleaseTarget,
  templateBytesDigest,
  type TemplateContent,
} from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";

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
 * every tag counts.
 */
export async function greenState(
  top: string,
  sha: string,
  green: import("../workspace/declaration").CiGreen | null = null,
): Promise<{ state: "green" | "revoked" | "none"; ignored: Array<{ tag: string; status: string; reason: string }> }> {
  const { judgedCiTags } = await import("./release-revocation");
  let tags: Awaited<ReturnType<typeof judgedCiTags>>;
  try {
    tags = await judgedCiTags(top, green);
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
}

/**
 * The checks and the compile a cut makes before it builds or writes: the
 * commit is green and not revoked, the cut is signed when the release gate
 * asks, the tree is clean, every environment compiles with the same build
 * steps, and which artifacts are carried from an earlier release.
 */
async function prepare(req: CutRequest): Promise<Prepared> {
  const cwd = resolve(req.cwd);
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new ReleaseCutError("not-a-git-repository", "a release is cut from a commit, and this directory is not in a git repository");
  const commit = await getHeadCommit({ cwd });

  // #4031: the declaration at base says whether tags need a statement and who may cut.
  const { scopeSource } = await import("../workspace/write-scope");
  const { releaseRuleFrom } = await import("../workspace/identity");
  const source = scopeSource(cwd);
  const { state, ignored } = await greenState(top, commit, source.declaration?.ci?.green ?? null);
  if (state !== "green") {
    const why = ignored.length > 0 ? `; ignored: ${ignored.map((t) => `${t.tag} (${t.status}): ${t.reason}`).join("; ")}` : "";
    throw new ReleaseCutError(
      state === "revoked" ? "release-commit-revoked" : "release-commit-not-green",
      state === "revoked"
        ? `commit ${commit.slice(0, 12)} has a ci/revoked tag: it went red after it was green, so no release is cut from it`
        : ignored.some((t) => t.tag.startsWith("ci/green/"))
          ? `commit ${commit.slice(0, 12)} has no ci/green tag that counts, so no release is cut from it${why}`
          : `commit ${commit.slice(0, 12)} has no ci/green tag, so no release is cut from it`,
      "Check out a green commit (`chant ci last-green` names the newest) after fetching the tags: git fetch origin --tags",
    );
  }
  // Who may cut is the declaration's identity.gates.release, read at base.
  const releaseRule = releaseRuleFrom(source);
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
  targets: Array<{ env: string; params: ReleaseTarget["params"]; templates: Array<{ component: string | null; path: string }> }>;
  /** The components whose artifacts would be built, and the environment each is built in. */
  build: Array<{ component: string; env: string }>;
  /** The components whose artifacts would be carried from an earlier release. */
  reused: CutResult["reused"];
  /** Each component's publish steps, with the environments whose deploy runs them. */
  publishSteps: Array<{ component: string; kind: string; to: string | null; envs: string[] }>;
  /** Whether the release gate in identity.gates requires a signed cut. */
  signatureRequired: boolean;
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
    targets: targets.map((t) => ({ env: t.env, params: t.params, templates: t.templates.map(({ component, path }) => ({ component, path })) })),
    build,
    reused: p.reused,
    publishSteps: [...steps.values()],
    signatureRequired: p.releaseRule.requirement !== null,
  };
}

/**
 * Cut a release of the member at `req.cwd` from its checkout's `HEAD`. Writes
 * the release and the cut to the local `chant/lifecycle` branch and does not
 * push. Throws {@link ReleaseCutError} before anything is written when the
 * commit isn't green, the tree is dirty, or an environment can't be compiled
 * to the same artifacts, and `ReleaseLabelError` (./release-store.ts) when the
 * label is taken or the release already carries another one.
 *
 * The cut line names its run (#4027): the CI run's id and origin in CI, and
 * outside CI an id minted from the cut's time, `local-<epoch ms>`, with the
 * origin `{ forge: "local" }`.
 */
export async function cutRelease(req: CutRequest): Promise<CutResult> {
  const p = await prepare(req);
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
  const outcome = await appendCut(
    {
      releaseDigest: release.releaseDigest,
      label: req.label,
      actor: req.actor,
      timestamp,
      runId: ci?.runId ?? `local-${Date.parse(timestamp)}`,
      runOrigin: ci?.runOrigin ?? { forge: "local" },
      signature,
      ...(req.composed ? { composed: req.composed } : {}),
      ...(req.channel ? { channel: req.channel } : {}),
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
