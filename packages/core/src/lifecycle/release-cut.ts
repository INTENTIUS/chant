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
 * Compiling goes through a {@link TargetCompiler}, so a test hands the cut
 * fixtures and the CLI hands it child processes.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalJson } from "../effect-receipt";
import { contentDigest } from "../content-digest";
import { getHeadCommit } from "./git";
import { resolveMemberLedger } from "./member-ledger";
import { resolveCiRun } from "./release-ledger";
import {
  appendCut,
  makeRelease,
  persistRelease,
  readAllReleases,
  readCuts,
  type Release,
  type ReleaseArtifact,
  type ReleaseCut,
  type ReleaseTarget,
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
  | "release-build-inputs-differ";

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

/** Whether `sha` has a green tag and no revoked tag, read from local tags. */
export async function greenState(top: string, sha: string): Promise<"green" | "revoked" | "none"> {
  const { readCiTags } = await import("../workspace/ci-green");
  const tags = readCiTags(top);
  if (tags.revoked.has(sha)) return "revoked";
  return tags.green.has(sha) ? "green" : "none";
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

/**
 * Cut a release of the member at `req.cwd` from its checkout's `HEAD`. Writes
 * the release and the cut to the local `chant/lifecycle` branch and does not
 * push. Throws {@link ReleaseCutError} before anything is written when the
 * commit isn't green, the tree is dirty, or an environment can't be compiled
 * to the same artifacts, and `ReleaseLabelError` (./release-store.ts) when the
 * label is taken or the release already carries another one.
 */
export async function cutRelease(req: CutRequest): Promise<CutResult> {
  const cwd = resolve(req.cwd);
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new ReleaseCutError("not-a-git-repository", "a release is cut from a commit, and this directory is not in a git repository");
  const commit = await getHeadCommit({ cwd });

  const state = await greenState(top, commit);
  if (state !== "green") {
    throw new ReleaseCutError(
      state === "revoked" ? "release-commit-revoked" : "release-commit-not-green",
      state === "revoked"
        ? `commit ${commit.slice(0, 12)} has a ci/revoked tag: it went red after it was green, so no release is cut from it`
        : `commit ${commit.slice(0, 12)} has no ci/green tag, so no release is cut from it`,
      "Check out a green commit (`chant ci last-green` names the newest) after fetching the tags: git fetch origin --tags",
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

  if (compiled.every((t) => t.components.length === 0)) {
    throw new ReleaseCutError("release-no-components", "no components were discovered in any environment; a release of a project with no components is not cut yet");
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
  for (const env of envs) {
    const names = toBuild.get(env);
    if (names) artifacts.push(...(await req.compiler.buildArtifacts(env, names)));
  }

  const templates: TemplateContent[] = [];
  const targets: ReleaseTarget[] = compiled.map((t) => ({
    env: t.env,
    params: t.params,
    templates: t.templates.map((tpl) => {
      const digest = contentDigest(tpl.content);
      templates.push({ digest, content: tpl.content });
      return { component: tpl.component, path: tpl.path, digest };
    }),
  }));

  const ledger = await resolveMemberLedger(cwd);
  const release = makeRelease({ member: ledger.members.length > 0 ? ledger.members.join("/") : null, commit, artifactDigests: artifacts, targets });
  const stored = await persistRelease(release, templates, { cwd });
  const ci = resolveCiRun(req.env ?? process.env);
  const outcome = await appendCut(
    {
      releaseDigest: release.releaseDigest,
      label: req.label,
      actor: req.actor,
      timestamp: (req.now ?? (() => new Date()))().toISOString(),
      runOrigin: ci?.runOrigin ?? null,
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
