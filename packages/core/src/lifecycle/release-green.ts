/**
 * The green gate of a release cut (#5149): what says a commit may be
 * released, set by `release.green` in the member's `chant.config.ts`.
 *
 * - `chant`: the commit carries a `ci/green/<sha>` tag and no
 *   `ci/revoked/<sha>` tag, as `chant ci` writes them from `ci.green`
 *   (./release-cut.ts). The default when `chant.workspace.json` declares
 *   `ci.green` or the repository holds any `ci/green/` tag.
 * - `forge-checks`: the forge's checks on the commit passed. Each check is
 *   judged by its newest run on the commit (GitHub: per check name and app,
 *   and per status context; newest completion time, ties by highest id), so
 *   a failed merge_group run followed by a passing push run is green.
 *   GitHub: every check run and commit status, and each check a branch rule of the
 *   branch requires. Forgejo: every commit status, and each context its
 *   branch protection requires when the token can read it. GitLab: the
 *   newest pipeline of each source on the commit. A check that failed or has
 *   not finished refuses the cut, and so does a commit with no check at all.
 *   The release workflow's own runs on the commit are left out (GitHub:
 *   every run of the workflow file the cut runs in; Forgejo: the cut's run;
 *   GitLab: pipelines started the way the cut's was, from the web or the
 *   API). The default otherwise.
 * - `none`: no gate. The cut prints a warning and records that it had none.
 *   Refused under the `supply-chain` or `verified-releases` security groups
 *   and under a `release` gate in `identity.gates`.
 *
 * The cut records the gate it passed on its cut line (`green`): the tag, the
 * forge and the names of the checks, or `none`. `chant release verify` shows
 * it and the publish's provenance statement carries it.
 *
 * The forge is the CI job's when the cut runs in one (`GITHUB_REPOSITORY`,
 * `CI_PROJECT_ID`, ...), and otherwise the one the checkout's `origin`
 * remote names. The token is read in the order every chant forge client
 * reads it (`FORGE_TOKEN_ORDER`): `CHANT_GITHUB_TOKEN`, `GH_TOKEN`,
 * `GITHUB_TOKEN` on GitHub, and the like on Forgejo and GitLab.
 */

import type { ForgeFetch, ForgeKind, ForgeTarget } from "../pr-forge";

/** `release.green`. */
export const RELEASE_GREEN_SOURCES = ["chant", "forge-checks", "none"] as const;
export type ReleaseGreenSource = (typeof RELEASE_GREEN_SOURCES)[number];

/**
 * The gate a cut checks: `release.green`, else `chant` when the workspace
 * declares `ci.green` or the repository holds `ci/green/` tags (a project
 * that writes them some other way, as before #5149), else `forge-checks`.
 */
export function resolveGreenSource(declared: ReleaseGreenSource | undefined, hasCiGreen: boolean, hasGreenTags = false): ReleaseGreenSource {
  return declared ?? (hasCiGreen || hasGreenTags ? "chant" : "forge-checks");
}

/** One check the forge reports on a commit. */
export interface ForgeCheck {
  name: string;
  state: "success" | "pending" | "failure";
  /** The forge's own word for it, for a message. */
  status: string;
  url?: string;
}

/** What the forge says of a commit's checks. */
export type ForgeChecksVerdict =
  | { green: true; forge: ForgeKind; checks: string[] }
  | { green: false; forge: ForgeKind; why: string; checks: ForgeCheck[] };

/** The forge could not be asked: none is known, a token is missing, or the forge answered with an error. */
export class ForgeChecksUnavailableError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ForgeChecksUnavailableError";
  }
}

/** Reads a commit's checks; a test hands in a fake. */
export type ForgeChecksReader = (commit: string, branch: string | null) => Promise<ForgeChecksVerdict>;

const PENDING = new Set(["queued", "in_progress", "waiting", "requested", "pending", "running", "created", "preparing", "waiting_for_resource", "scheduled", "manual"]);
const PASSED = new Set(["success", "neutral", "skipped", "warning"]);

/** A check's state from the forge's status and, once completed, conclusion. */
export function checkState(status: string, conclusion?: string | null): ForgeCheck["state"] {
  const s = status.toLowerCase();
  if (PENDING.has(s)) return "pending";
  const word = (s === "completed" ? (conclusion ?? "") : s).toLowerCase();
  return PASSED.has(word) ? "success" : "failure";
}

/**
 * The verdict on `checks`: green when there is at least one, each passed,
 * and each of `required` is among them.
 */
export function judgeChecks(forge: ForgeKind, checks: ForgeCheck[], required: readonly string[]): ForgeChecksVerdict {
  const names = new Set(checks.map((c) => c.name));
  const missing = required.filter((r) => !names.has(r));
  const failed = checks.filter((c) => c.state === "failure");
  const pending = checks.filter((c) => c.state === "pending");
  const list = (cs: ForgeCheck[]) => cs.map((c) => `${c.name} (${c.status})`).join(", ");
  if (checks.length === 0) return { green: false, forge, checks, why: `${forge} reports no check on it` };
  if (failed.length > 0) return { green: false, forge, checks, why: `${failed.length === 1 ? "a check" : `${failed.length} checks`} did not pass on ${forge}: ${list(failed)}` };
  if (pending.length > 0) return { green: false, forge, checks, why: `${pending.length === 1 ? "a check has" : `${pending.length} checks have`} not finished on ${forge}: ${list(pending)}` };
  if (missing.length > 0) return { green: false, forge, checks, why: `the branch requires ${missing.join(", ")}, which ${forge} does not report on it` };
  return { green: true, forge, checks: [...names].sort() };
}

/** A reading of a check with what orders it among the reruns of the same check. */
interface Reading {
  key: string;
  at: number;
  id: number;
  check: ForgeCheck;
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const time = (...vs: unknown[]): number => {
  for (const v of vs) {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (!Number.isNaN(t)) return t;
  }
  return 0;
};

/** The newest reading of each key: latest time, ties by highest id. A rerun, or a later run on the same commit, supersedes the one before it, as in GitHub's own rollup. */
function newestRuns(readings: Reading[]): ForgeCheck[] {
  const out = new Map<string, Reading>();
  for (const r of readings) {
    const had = out.get(r.key);
    if (!had || r.at > had.at || (r.at === had.at && r.id > had.id)) out.set(r.key, r);
  }
  return [...out.values()].map((r) => r.check);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Whether `url` is a page of one of the CI runs `runIds` (`.../actions/runs/<id>` or `.../actions/runs/<id>/...`). */
function inRun(url: string | undefined, runIds: ReadonlySet<string> | string | undefined): boolean {
  if (!url || !runIds) return false;
  const m = /\/actions\/runs\/([0-9A-Za-z]+)(?:\/|$)/.exec(url);
  if (!m) return false;
  return typeof runIds === "string" ? m[1] === runIds : runIds.has(m[1]!);
}

/**
 * A reader of the commit checks of the forge `target` names, with `env`
 * naming the run the cut runs in, whose own checks are left out.
 */
export function forgeChecksReader(target: ForgeTarget, env: Record<string, string | undefined> = process.env, fetchImpl?: ForgeFetch): ForgeChecksReader {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as ForgeFetch);
  const api = target.apiBase.replace(/\/+$/, "");
  const headers: Record<string, string> =
    target.kind === "gitlab"
      ? { [target.tokenHeader ?? "PRIVATE-TOKEN"]: target.token, Accept: "application/json" }
      : target.kind === "github"
        ? { Authorization: `Bearer ${target.token}`, Accept: "application/vnd.github+json" }
        : { Authorization: `token ${target.token}`, Accept: "application/json" };
  /** GET a JSON document; `optional` answers undefined for a refusal or a missing resource rather than throwing. */
  const get = async (path: string, optional = false): Promise<unknown> => {
    const url = `${api}${path}`;
    let res: Awaited<ReturnType<ForgeFetch>>;
    try {
      res = await doFetch(url, { method: "GET", headers });
    } catch (err) {
      throw new ForgeChecksUnavailableError(`${target.kind} could not be reached at ${api}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      if (optional && [401, 403, 404].includes(res.status)) return undefined;
      throw new ForgeChecksUnavailableError(
        `${target.kind} answered ${res.status} to GET ${path}`,
        res.status === 401 || res.status === 403 || res.status === 404
          ? `The token from ${target.tokenSource} must read the repository's checks and statuses (GitHub: checks: read and statuses: read).`
          : undefined,
      );
    }
    try {
      return JSON.parse(await res.text());
    } catch {
      throw new ForgeChecksUnavailableError(`${target.kind} answered GET ${path} with something that is not JSON`);
    }
  };

  if (target.kind === "github") {
    const repo = `/repos/${target.repo}`;
    // The release workflow's own runs on the commit, this one and any earlier attempt, are not checks of it.
    const workflowPath = env.GITHUB_WORKFLOW_REF ? /^[^/]+\/[^/]+\/(.+?)@/.exec(env.GITHUB_WORKFLOW_REF)?.[1] : undefined;
    return async (sha, branch) => {
      const runId = new Set(env.GITHUB_RUN_ID ? [env.GITHUB_RUN_ID] : []);
      if (workflowPath) {
        const runs = await get(`${repo}/actions/runs?head_sha=${sha}&per_page=100`, true);
        for (const r of isObject(runs) && Array.isArray(runs.workflow_runs) ? runs.workflow_runs.filter(isObject) : []) {
          if (str(r.path) === workflowPath && r.id !== undefined) runId.add(String(r.id));
        }
      }
      const runReadings: Reading[] = [];
      for (let page = 1; page <= 20; page++) {
        const got = await get(`${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
        const runs = isObject(got) && Array.isArray(got.check_runs) ? got.check_runs.filter(isObject) : [];
        for (const r of runs) {
          const name = str(r.name);
          const url = str(r.details_url) ?? str(r.html_url);
          if (!name || inRun(url, runId)) continue;
          const status = str(r.status) ?? "unknown";
          const conclusion = str(r.conclusion) ?? null;
          const app = isObject(r.app) ? String(r.app.id ?? r.app.slug ?? "") : "";
          runReadings.push({
            key: `${app}\0${name}`,
            at: time(r.completed_at, r.started_at),
            id: num(r.id),
            check: { name, state: checkState(status, conclusion), status: status === "completed" ? (conclusion ?? status) : status, ...(url ? { url } : {}) },
          });
        }
        if (runs.length < 100) break;
      }
      const checks = newestRuns(runReadings);
      const combined = await get(`${repo}/commits/${sha}/status?per_page=100`);
      const statusReadings: Reading[] = [];
      for (const s of isObject(combined) && Array.isArray(combined.statuses) ? combined.statuses.filter(isObject) : []) {
        const name = str(s.context);
        const url = str(s.target_url);
        if (!name || inRun(url, runId)) continue;
        const state = str(s.state) ?? "unknown";
        statusReadings.push({ key: name, at: time(s.updated_at, s.created_at), id: num(s.id), check: { name, state: state === "error" ? "failure" : checkState(state), status: state, ...(url ? { url } : {}) } });
      }
      checks.push(...newestRuns(statusReadings));
      const required: string[] = [];
      if (branch) {
        const rules = await get(`${repo}/rules/branches/${encodeURIComponent(branch)}`, true);
        for (const rule of Array.isArray(rules) ? rules.filter(isObject) : []) {
          if (rule.type !== "required_status_checks" || !isObject(rule.parameters)) continue;
          const list = rule.parameters.required_status_checks;
          for (const c of Array.isArray(list) ? list.filter(isObject) : []) {
            const ctx = str(c.context);
            if (ctx && !required.includes(ctx)) required.push(ctx);
          }
        }
      }
      return judgeChecks("github", newestByName(checks), required);
    };
  }

  if (target.kind === "forgejo") {
    const runNumber = env.FORGEJO_RUN_NUMBER ?? env.GITHUB_RUN_NUMBER;
    const repo = `/repos/${target.repo}`;
    return async (sha, branch) => {
      const combined = await get(`${repo}/commits/${sha}/status?limit=100`);
      const readings: Reading[] = [];
      for (const s of isObject(combined) && Array.isArray(combined.statuses) ? combined.statuses.filter(isObject) : []) {
        const name = str(s.context);
        const url = str(s.target_url);
        if (!name || inRun(url, runNumber)) continue;
        const state = str(s.status) ?? str(s.state) ?? "unknown";
        readings.push({ key: name, at: time(s.updated_at, s.created_at), id: num(s.id), check: { name, state: state === "error" ? "failure" : checkState(state), status: state, ...(url ? { url } : {}) } });
      }
      const checks = newestRuns(readings);
      const required: string[] = [];
      if (branch) {
        const protections = await get(`${repo}/branch_protections`, true);
        for (const p of Array.isArray(protections) ? protections.filter(isObject) : []) {
          const names = [str(p.rule_name), str(p.branch_name)];
          if (!names.includes(branch) || p.enable_status_check !== true) continue;
          for (const ctx of Array.isArray(p.status_check_contexts) ? p.status_check_contexts : []) if (typeof ctx === "string" && !required.includes(ctx)) required.push(ctx);
        }
      }
      return judgeChecks("forgejo", newestByName(checks), required);
    };
  }

  const pipelineId = env.CI_PIPELINE_ID;
  // A release started from "Run pipeline" or the API is such a pipeline itself, as are earlier attempts of it.
  const ownSource = ["web", "api", "trigger"].includes(env.CI_PIPELINE_SOURCE ?? "") ? env.CI_PIPELINE_SOURCE : undefined;
  const project = `/projects/${encodeURIComponent(target.repo)}`;
  return async (sha) => {
    const got = await get(`${project}/pipelines?sha=${encodeURIComponent(sha)}&per_page=100&order_by=id&sort=desc`);
    const checks: ForgeCheck[] = [];
    const seen = new Set<string>();
    for (const p of Array.isArray(got) ? got.filter(isObject) : []) {
      const id = p.id;
      if (id === undefined || String(id) === pipelineId || (ownSource !== undefined && p.source === ownSource)) continue;
      // The newest pipeline of each source (push, merge_request_event, schedule, ...) speaks for it.
      const name = `pipeline (${str(p.source) ?? "unknown"})`;
      if (seen.has(name)) continue;
      seen.add(name);
      const status = str(p.status) ?? "unknown";
      const url = str(p.web_url);
      checks.push({ name, state: status === "canceled" ? "failure" : checkState(status), status, ...(url ? { url } : {}) });
    }
    return judgeChecks("gitlab", checks, []);
  };
}

/** Each check name once, at the worst state any entry of that name has, so a check run and a status of the same name can't hide a failure. Reruns of one check are already collapsed to the newest by `newestRuns`. */
function newestByName(checks: ForgeCheck[]): ForgeCheck[] {
  const rank = { failure: 2, pending: 1, success: 0 } as const;
  const out = new Map<string, ForgeCheck>();
  for (const c of checks) {
    const had = out.get(c.name);
    if (!had || rank[c.state] > rank[had.state]) out.set(c.name, c);
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The forge a cut in `cwd` asks: the CI job's, read from `env`, or the one
 * the checkout's `origin` remote names, with the token from `env`. Throws
 * {@link ForgeChecksUnavailableError} naming what is missing.
 */
export async function forgeChecksTarget(cwd: string, env: Record<string, string | undefined> = process.env): Promise<ForgeTarget> {
  const { detectForge, forgeTargetFromEnv, ForgeEnvironmentError, FORGE_TOKEN_ORDER } = await import("../pr-forge");
  const inCi = detectForge(env);
  if (inCi) {
    try {
      return forgeTargetFromEnv(env, { kind: inCi });
    } catch (err) {
      if (err instanceof ForgeEnvironmentError) {
        throw new ForgeChecksUnavailableError(
          `release.green is forge-checks, and this ${inCi} job can't ask ${inCi} for the commit's checks: it needs ${err.missing.join(", ")}`,
          inCi === "github" ? "Give the job its token (env GITHUB_TOKEN: ${{ github.token }}) with checks: read and statuses: read." : `Set ${FORGE_TOKEN_ORDER[inCi][0]} to a token that reads the repository's pipelines and statuses.`,
        );
      }
      throw err;
    }
  }
  const { forgeOfCheckout } = await import("../forge-remote");
  const remote = forgeOfCheckout(cwd);
  if (!remote) {
    throw new ForgeChecksUnavailableError(
      "release.green is forge-checks, and the origin remote names no forge chant reads checks from (GitHub, GitLab or Forgejo)",
      'Cut from a checkout whose origin is on GitHub, GitLab or Forgejo, or set release.green in chant.config.ts to "chant" (ci/green tags) or "none".',
    );
  }
  const names = FORGE_TOKEN_ORDER[remote.kind];
  const tokenSource = names.find((n) => env[n]?.trim());
  if (!tokenSource) {
    throw new ForgeChecksUnavailableError(
      `release.green is forge-checks, and no token to ask ${remote.kind} (${remote.host}) for the commit's checks is set: ${names.join(", ")}`,
      remote.kind === "github" ? "Set GH_TOKEN, for one: GH_TOKEN=$(gh auth token) chant release cut ..." : `Set ${names[0]} to a token that reads ${remote.repo}.`,
    );
  }
  const apiBase =
    remote.kind === "github" ? (remote.host === "github.com" ? "https://api.github.com" : `${remote.url}/api/v3`) : remote.kind === "gitlab" ? `${remote.url}/api/v4` : `${remote.url}/api/v1`;
  return {
    kind: remote.kind,
    apiBase,
    repo: remote.repo,
    host: remote.host,
    token: env[tokenSource]!.trim(),
    tokenSource,
    ...(remote.kind === "gitlab" ? { tokenHeader: "PRIVATE-TOKEN" as const } : {}),
  };
}
