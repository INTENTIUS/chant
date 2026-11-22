/**
 * Whether the forge refuses a force push to and a deletion of `chant/lifecycle`
 * (#5469), read-only.
 *
 * The branch holds the audit trail. The `pre-receive` hook `chant workspace
 * ref-gate install` writes refuses a rewrite or a deletion of it
 * (`lifecycle-ref-rewritten`, `lifecycle-ref-deleted`), but only where that
 * hook runs. On a forge the hook is the forge's own, so this reads the
 * forge's settings:
 *
 * - GitHub: the rules that apply to the branch from rulesets (`deletion`,
 *   `non_fast_forward`) and the branch's classic protection
 *   (`allow_force_pushes`, `allow_deletions`);
 * - GitLab: the protected branches of the project, whose entries refuse a
 *   deletion and refuse a force push unless `allow_force_push` is set;
 * - Forgejo: the branch protection rules, matched by their branch pattern,
 *   which refuse a deletion and refuse a force push unless
 *   `enable_force_push` is set.
 *
 * Each answer is `refused`, `allowed`, or `unknown` when the token can't
 * read the setting (the forge answers 401 or 403) or the forge can't be
 * reached. Nothing is changed.
 */

/** The branch the audit trail is kept on. */
export const LIFECYCLE_BRANCH = "chant/lifecycle";

export type ProtectionAnswer = "refused" | "allowed" | "unknown";

export interface LifecycleProtection {
  /** Whether a force push to the branch is refused. */
  force: ProtectionAnswer;
  /** Whether a deletion of the branch is refused. */
  deletion: ProtectionAnswer;
  /** What the answers came from, or why they are unknown, in a sentence. */
  detail: string;
}

/** The forge to ask: the part of {@link import("../pr-forge").ForgeTarget} the read needs. */
export interface ProtectionTarget {
  kind: "github" | "gitlab" | "forgejo";
  apiBase: string;
  repo: string;
  token: string;
  tokenHeader?: "PRIVATE-TOKEN" | "JOB-TOKEN";
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Any of `answers` refused is refused; else any unknown is unknown; else allowed. */
function combine(...answers: ProtectionAnswer[]): ProtectionAnswer {
  if (answers.includes("refused")) return "refused";
  return answers.includes("unknown") ? "unknown" : "allowed";
}

/** A branch pattern as the forge writes it (`*` within a segment, `**` across them) as a RegExp. */
function branchPattern(pattern: string): RegExp {
  const body = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** Read whether `target`'s forge refuses force pushes to and deletions of {@link LIFECYCLE_BRANCH}. */
export async function readLifecycleProtection(target: ProtectionTarget, doFetch: Fetch = globalThis.fetch as unknown as Fetch): Promise<LifecycleProtection> {
  const api = target.apiBase.replace(/\/+$/, "");
  const headers: Record<string, string> =
    target.kind === "gitlab"
      ? { [target.tokenHeader ?? "PRIVATE-TOKEN"]: target.token, Accept: "application/json" }
      : target.kind === "github"
        ? { Authorization: `Bearer ${target.token}`, Accept: "application/vnd.github+json" }
        : { Authorization: `token ${target.token}`, Accept: "application/json" };
  /** One GET: the status and the JSON body, or null for a forge that could not be reached. */
  const get = async (path: string): Promise<{ status: number; json: unknown } | null> => {
    try {
      const res = await doFetch(`${api}${path}`, { method: "GET", headers });
      const text = await res.text().catch(() => "");
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  };
  const unreadable = (what: string, r: { status: number } | null): LifecycleProtection => ({
    force: "unknown",
    deletion: "unknown",
    detail: r === null ? `${target.kind} could not be reached at ${api}` : `${target.kind} answered ${r.status} to ${what}, so the token can't read the branch's protection`,
  });

  if (target.kind === "github") {
    const repo = `/repos/${target.repo}`;
    const rules = await get(`${repo}/rules/branches/${LIFECYCLE_BRANCH}`);
    const classic = await get(`${repo}/branches/${LIFECYCLE_BRANCH}/protection`);
    if (rules === null && classic === null) return unreadable("the branch's rules", null);
    const fromRules: Pick<LifecycleProtection, "force" | "deletion"> = (() => {
      if (rules?.status !== 200 || !Array.isArray(rules.json)) return { force: "unknown", deletion: "unknown" };
      const types = new Set((rules.json as Array<{ type?: string }>).map((r) => r.type));
      return { force: types.has("non_fast_forward") ? "refused" : "allowed", deletion: types.has("deletion") ? "refused" : "allowed" };
    })();
    const fromClassic: Pick<LifecycleProtection, "force" | "deletion"> = (() => {
      if (classic?.status === 404) return { force: "allowed", deletion: "allowed" };
      if (classic?.status !== 200 || typeof classic.json !== "object" || classic.json === null) return { force: "unknown", deletion: "unknown" };
      const c = classic.json as { allow_force_pushes?: { enabled?: boolean }; allow_deletions?: { enabled?: boolean } };
      return { force: c.allow_force_pushes?.enabled === true ? "allowed" : "refused", deletion: c.allow_deletions?.enabled === true ? "allowed" : "refused" };
    })();
    const force = combine(fromRules.force, fromClassic.force);
    const deletion = combine(fromRules.deletion, fromClassic.deletion);
    const read = [rules?.status === 200 ? "rulesets" : null, classic?.status === 200 || classic?.status === 404 ? "branch protection" : null].filter(Boolean);
    return {
      force,
      deletion,
      detail: read.length === 2 ? "read from the rulesets that apply to the branch and its branch protection" : read.length === 1 ? `read from ${read[0]} only; the token can't read the other (rulesets answered ${rules?.status ?? "nothing"}, branch protection ${classic?.status ?? "nothing"})` : unreadable("the branch's protection", classic ?? rules).detail,
    };
  }

  if (target.kind === "gitlab") {
    const list = await get(`/projects/${encodeURIComponent(target.repo)}/protected_branches?per_page=100`);
    if (list?.status !== 200 || !Array.isArray(list.json)) return unreadable("the project's protected branches", list);
    const entries = list.json as Array<{ name?: string; allow_force_push?: boolean }>;
    const found = entries.find((e) => typeof e.name === "string" && branchPattern(e.name).test(LIFECYCLE_BRANCH));
    if (!found) return { force: "allowed", deletion: "allowed", detail: `no protected branch of the project matches ${LIFECYCLE_BRANCH}` };
    return { force: found.allow_force_push === true ? "allowed" : "refused", deletion: "refused", detail: `the protected branch ${found.name} matches it` };
  }

  const list = await get(`/repos/${target.repo}/branch_protections`);
  if (list?.status !== 200 || !Array.isArray(list.json)) return unreadable("the repository's branch protections", list);
  const rules = list.json as Array<{ rule_name?: string; branch_name?: string; enable_force_push?: boolean }>;
  const found = rules.find((r) => branchPattern(r.rule_name ?? r.branch_name ?? "").test(LIFECYCLE_BRANCH) && (r.rule_name ?? r.branch_name));
  if (!found) return { force: "allowed", deletion: "allowed", detail: `no branch protection rule matches ${LIFECYCLE_BRANCH}` };
  return { force: found.enable_force_push === true ? "allowed" : "refused", deletion: "refused", detail: `the rule ${found.rule_name ?? found.branch_name} matches it` };
}

/** The doctor's verdict on a protection read. */
export function protectionVerdict(p: LifecycleProtection): { status: "ok" | "warn" | "unknown"; message: string; fix?: string } {
  if (p.force === "refused" && p.deletion === "refused") return { status: "ok", message: `the forge refuses force pushes to and deletions of ${LIFECYCLE_BRANCH}: ${p.detail}` };
  const allowed = [p.force === "allowed" ? "force pushes" : null, p.deletion === "allowed" ? "deletions" : null].filter(Boolean);
  if (allowed.length > 0) {
    return {
      status: "warn",
      message: `the forge does not refuse ${allowed.join(" or ")} of ${LIFECYCLE_BRANCH}, which holds the audit trail: ${p.detail}`,
      fix: `Protect ${LIFECYCLE_BRANCH}: a branch protection rule or ruleset that blocks force pushes and deletions (GitHub), a protected branch with force push off (GitLab), or a branch protection rule with force push off (Forgejo). The pre-receive hook of chant workspace ref-gate install refuses both where the remote runs it.`,
    };
  }
  return { status: "unknown", message: `whether the forge refuses force pushes to and deletions of ${LIFECYCLE_BRANCH} can't be read: ${p.detail}`, fix: "Give the token read access to the repository's branch protection (GitHub: administration: read; GitLab: read_api; Forgejo: a token that reads the repository's settings)." };
}
