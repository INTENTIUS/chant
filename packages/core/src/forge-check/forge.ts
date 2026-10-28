/**
 * The forge's side of the check (#4608), lifted from terragucci's
 * `forge check` and widened to branch protection and required statuses:
 *
 *   GitHub   each apply job's forge environment exists and deploys from the
 *            default branch alone (protected branches, or one custom policy
 *            naming the default branch); each apply runner group is limited
 *            to selected workflows (org-level, so a token without
 *            Self-hosted runners: read gets `unknown`); each protected
 *            branch is protected by branch protection or a ruleset, and the
 *            default branch requires each required status
 *   GitLab   each forge environment is protected (Premium: on another
 *            edition the row is `unknown`); every runner carrying an apply
 *            runner's tags takes protected refs only; each variable the apply
 *            jobs read is protected and scoped to their environment; each
 *            protected branch is protected; merge requests need a passing
 *            pipeline, which holds the required statuses
 *   Forgejo  each protected branch is protected, and its rule checks each
 *            required status
 *
 * The default branch's head is read through chant's forge client
 * (`branchHead` and `commitStatuses`, #4554), so a required status no job
 * has posted yet shows as `unknown` before it blocks every merge.
 */

import { forgeClient, ForgeApiError, type ForgeFetch, type ForgeTarget } from "../pr-forge";
import type { ForgeCheckContract, ForgeCheckJob, LiveRepository } from "./contract";
import { ReadOnlyError } from "./read-only";
import { couldNot, SCOPES, unique, type CheckRow, type CheckStatus, type Read } from "./types";

const authHeaders = (t: ForgeTarget): Record<string, string> => {
  if (t.kind === "gitlab") return t.token ? { [t.tokenHeader ?? "PRIVATE-TOKEN"]: t.token } : {};
  if (t.kind === "github") return { ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}), Accept: "application/vnd.github+json" };
  return { ...(t.token ? { Authorization: `token ${t.token}` } : {}), Accept: "application/json" };
};

/** A GET of `path` under the target's REST base, parsed as JSON. */
export async function read<T>(fetch: ForgeFetch, t: ForgeTarget, path: string): Promise<Read<T>> {
  const url = `${t.apiBase.replace(/\/+$/, "")}${path}`;
  try {
    const res = await fetch(url, { method: "GET", headers: authHeaders(t) });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, why: text.slice(0, 300) };
    return { ok: true, value: (text ? JSON.parse(text) : null) as T };
  } catch (e) {
    if (e instanceof ReadOnlyError) throw e;
    return { ok: false, status: undefined, why: (e as Error).message };
  }
}

/** The project path a GitLab call takes. */
const projectPath = (t: ForgeTarget): string => `/projects/${encodeURIComponent(decodeURIComponent(t.repo))}`;

/** The repository's default branch, full path and (Forgejo) numeric ids. */
export async function readRepository(fetch: ForgeFetch, t: ForgeTarget): Promise<Read<LiveRepository>> {
  const r = await read<{ default_branch?: string; id?: number; full_name?: string; path_with_namespace?: string; owner?: { id?: number } }>(fetch, t, t.kind === "gitlab" ? projectPath(t) : `/repos/${t.repo}`);
  if (!r.ok) return r;
  const v = r.value ?? {};
  const path = t.kind === "gitlab" ? v.path_with_namespace : v.full_name;
  return {
    ok: true,
    value: {
      ...(v.default_branch ? { defaultBranch: v.default_branch } : {}),
      ...(path ? { path } : {}),
      ...(t.kind === "forgejo" && v.owner?.id !== undefined ? { ownerId: String(v.owner.id) } : {}),
      ...(t.kind === "forgejo" && v.id !== undefined ? { repoId: String(v.id) } : {}),
    },
  };
}

const applyJobs = (c: ForgeCheckContract): ForgeCheckJob[] => c.jobs.filter((j) => j.identity === "apply");
const forgeEnvironments = (c: ForgeCheckContract): string[] => unique(applyJobs(c).flatMap((j) => (j.forgeEnvironment ? [j.forgeEnvironment] : [])));
const protectedBranches = (c: ForgeCheckContract): string[] => unique(c.protectedBranches ?? [c.repository.defaultBranch]);

/** A branch glob as GitLab and Forgejo write them: `*` any run of characters. */
const branchGlob = (glob: string, branch: string): boolean => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`).test(branch);

/** One GitHub branch: whether branch protection or a ruleset protects it, and the status contexts either requires. */
async function githubBranch(fetch: ForgeFetch, t: ForgeTarget, b: string): Promise<{ found: string; status: CheckStatus; required: Read<string[]> }> {
  type Checks = { contexts?: string[]; checks?: { context: string }[] } | null;
  const br = await read<{ protected?: boolean; protection?: { required_status_checks?: Checks } }>(fetch, t, `/repos/${t.repo}/branches/${encodeURIComponent(b)}`);
  if (!br.ok) return { found: br.status === 404 ? "no such branch" : couldNot(br, SCOPES.github), status: br.status === 404 ? "mismatch" : "unknown", required: br };
  // Rulesets are readable with read access; a 404 means none applies.
  const rules = await read<{ type: string; parameters?: { required_status_checks?: { context: string }[] } }[]>(fetch, t, `/repos/${t.repo}/rules/branches/${encodeURIComponent(b)}`);
  const list = rules.ok && Array.isArray(rules.value) ? rules.value : [];
  const kinds = unique(list.map((r) => r.type));
  const byProtection = br.value?.protected === true;
  const found = [...(byProtection ? ["branch protection"] : []), ...(kinds.length ? [`rulesets: ${kinds.join(", ")}`] : [])].join("; ") || "not protected";
  const checks = br.value?.protection?.required_status_checks;
  const contexts = unique([...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((x) => x.context), ...list.flatMap((r) => (r.type === "required_status_checks" ? (r.parameters?.required_status_checks ?? []).map((x) => x.context) : []))]);
  return { found, status: byProtection || kinds.length > 0 ? "match" : "mismatch", required: { ok: true, value: contexts } };
}

export async function githubRows(fetch: ForgeFetch, t: ForgeTarget, c: ForgeCheckContract): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const branch = c.repository.defaultBranch;
  for (const env of forgeEnvironments(c)) {
    const row = (check: string, expected: string, found: string, status: CheckStatus): number => rows.push({ where: "github", check, subject: env, expected, found, status });
    const r = await read<{ deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null }>(fetch, t, `/repos/${t.repo}/environments/${encodeURIComponent(env)}`);
    if (!r.ok) {
      if (r.status === 404) row("environment", "exists", "missing", "mismatch");
      else row("environment", "exists", couldNot(r, SCOPES.github), "unknown");
      continue;
    }
    row("environment", "exists", "exists", "match");
    const expected = `deploys from ${branch} only`;
    const p = r.value?.deployment_branch_policy;
    if (!p) {
      row("deployment-branches", expected, "any branch: no deployment branch rule", "mismatch");
    } else if (p.protected_branches) {
      row("deployment-branches", expected, "protected branches", "match");
    } else {
      const b = await read<{ branch_policies?: { name: string; type?: string }[] }>(fetch, t, `/repos/${t.repo}/environments/${encodeURIComponent(env)}/deployment-branch-policies?per_page=100`);
      if (!b.ok) {
        row("deployment-branches", expected, couldNot(b, SCOPES.github), "unknown");
        continue;
      }
      const list = b.value?.branch_policies ?? [];
      const ok = list.length === 1 && list[0]!.name === branch && list[0]!.type !== "tag";
      row("deployment-branches", expected, `custom: ${list.map((x) => `${x.name}${x.type === "tag" ? " (tag)" : ""}`).join(", ") || "none"}`, ok ? "match" : "mismatch");
    }
  }
  const groups = unique(applyJobs(c).flatMap((j) => (j.runner?.group ? [j.runner.group] : [])));
  if (groups.length) {
    const owner = t.repo.split("/")[0]!;
    const r = await read<{ runner_groups?: { name: string; restricted_to_workflows?: boolean; selected_workflows?: string[] }[] }>(fetch, t, `/orgs/${owner}/actions/runner-groups?per_page=100`);
    for (const g of groups) {
      const expected = "limited to selected workflows";
      if (!r.ok) {
        rows.push({ where: "github", check: "runner-group", subject: g, expected, found: couldNot(r, SCOPES.githubOrg), status: "unknown" });
        continue;
      }
      const found = (r.value?.runner_groups ?? []).find((x) => x.name === g);
      if (!found) rows.push({ where: "github", check: "runner-group", subject: g, expected, found: `no runner group ${g} in ${owner}`, status: "mismatch" });
      else if (found.restricted_to_workflows) rows.push({ where: "github", check: "runner-group", subject: g, expected, found: `selected workflows: ${(found.selected_workflows ?? []).join(", ") || "none"}`, status: "match" });
      else rows.push({ where: "github", check: "runner-group", subject: g, expected, found: "every workflow", status: "mismatch" });
    }
  }
  const branches = unique([...protectedBranches(c), ...((c.requiredStatuses ?? []).length ? [branch] : [])]);
  let def: Read<string[]> | undefined;
  for (const b of branches) {
    const g = await githubBranch(fetch, t, b);
    if (b === branch) def = g.required;
    if (!protectedBranches(c).includes(b)) continue;
    rows.push({ where: "github", check: "protected-branch", subject: b, expected: "protected", found: g.found, status: g.status });
  }
  for (const ctx of c.requiredStatuses ?? []) {
    const expected = `${branch} requires ${ctx} before a merge`;
    if (!def || !def.ok) rows.push({ where: "github", check: "required-status", subject: ctx, expected, found: def ? couldNot(def, SCOPES.github) : "not read", status: "unknown" });
    else rows.push({ where: "github", check: "required-status", subject: ctx, expected, found: def.value.length ? `required: ${def.value.join(", ")}` : "no required status", status: def.value.includes(ctx) ? "match" : "mismatch" });
  }
  return rows;
}

export async function gitlabRows(fetch: ForgeFetch, t: ForgeTarget, c: ForgeCheckContract): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const pid = projectPath(t);
  const envs = forgeEnvironments(c);
  if (envs.length) {
    const r = await read<{ name: string }[]>(fetch, t, `${pid}/protected_environments?per_page=100`);
    for (const env of envs) {
      if (!r.ok) {
        const why = r.status === 404 || r.status === 403 ? `could not read (${r.status}); ${SCOPES.gitlabEdition}` : couldNot(r, SCOPES.gitlab);
        rows.push({ where: "gitlab", check: "protected-environment", subject: env, expected: "protected", found: why, status: "unknown" });
        continue;
      }
      const ok = (r.value ?? []).some((p) => p.name === env);
      rows.push({ where: "gitlab", check: "protected-environment", subject: env, expected: "protected", found: ok ? "protected" : "not protected", status: ok ? "match" : "mismatch" });
    }
  }
  const tagSets = new Map<string, string[]>();
  for (const j of applyJobs(c)) if (j.runner?.labels.length) tagSets.set([...j.runner.labels].sort().join(","), j.runner.labels);
  for (const tags of tagSets.values()) {
    const subject = `tags ${tags.join(", ")}`;
    const expected = "every runner with these tags runs protected refs only (ref_protected)";
    const r = await read<{ id: number; description?: string }[]>(fetch, t, `${pid}/runners?tag_list=${encodeURIComponent(tags.join(","))}&per_page=100`);
    if (!r.ok) {
      rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: couldNot(r, SCOPES.gitlab), status: "unknown" });
      continue;
    }
    const runners = r.value ?? [];
    if (runners.length === 0) {
      rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: "no runner of the project carries these tags", status: "mismatch" });
      continue;
    }
    const open: string[] = [];
    let unread: string | undefined;
    for (const runner of runners) {
      const d = await read<{ access_level?: string }>(fetch, t, `/runners/${runner.id}`);
      if (!d.ok) unread = couldNot(d, SCOPES.gitlab);
      else if (d.value?.access_level !== "ref_protected") open.push(`#${runner.id}${runner.description ? ` (${runner.description})` : ""} ${d.value?.access_level ?? "no access level"}`);
    }
    if (open.length) rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: open.join("; "), status: "mismatch" });
    else if (unread) rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: unread, status: "unknown" });
    else rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: `${runners.length} runner(s), each ref_protected`, status: "match" });
  }
  const names = unique(c.gitlabVariables ?? []);
  if (envs.length && names.length) {
    const vars: { key: string; protected?: boolean; environment_scope?: string }[] = [];
    let failed: Read<unknown> | undefined;
    for (let page = 1; page <= 50; page++) {
      const r = await read<typeof vars>(fetch, t, `${pid}/variables?per_page=100&page=${page}`);
      if (!r.ok) {
        failed = r;
        break;
      }
      vars.push(...(r.value ?? []));
      if ((r.value ?? []).length < 100) break;
    }
    for (const env of envs) {
      for (const name of names) {
        const subject = `${name} in ${env}`;
        const expected = `scoped to ${env}, protected`;
        if (failed && !failed.ok) {
          rows.push({ where: "gitlab", check: "variable", subject, expected, found: couldNot(failed, SCOPES.gitlab), status: "unknown" });
          continue;
        }
        const defs = vars.filter((v) => v.key === name);
        if (defs.length === 0) {
          rows.push({ where: "gitlab", check: "variable", subject, expected, found: "no project variable of this name (group and instance variables are not read)", status: "unknown" });
          continue;
        }
        const mine = defs.find((v) => v.environment_scope === env);
        const found = defs.map((v) => `scope ${v.environment_scope ?? "*"}, ${v.protected ? "protected" : "not protected"}`).join("; ");
        rows.push({ where: "gitlab", check: "variable", subject, expected, found, status: mine?.protected ? "match" : "mismatch" });
      }
    }
  }
  const branches = protectedBranches(c);
  const pb = await read<{ name: string }[]>(fetch, t, `${pid}/protected_branches?per_page=100`);
  for (const b of branches) {
    if (!pb.ok) {
      rows.push({ where: "gitlab", check: "protected-branch", subject: b, expected: "protected", found: couldNot(pb, SCOPES.gitlab), status: "unknown" });
      continue;
    }
    const rule = (pb.value ?? []).map((p) => p.name).find((n) => n === b || branchGlob(n, b));
    rows.push({ where: "gitlab", check: "protected-branch", subject: b, expected: "protected", found: rule ? `protected by ${rule}` : "not protected", status: rule ? "match" : "mismatch" });
  }
  if ((c.requiredStatuses ?? []).length) {
    const p = await read<{ only_allow_merge_if_pipeline_succeeds?: boolean; allow_merge_on_skipped_pipeline?: boolean }>(fetch, t, pid);
    for (const ctx of c.requiredStatuses ?? []) {
      const expected = `merge requests need a passing pipeline, which holds ${ctx}`;
      if (!p.ok) {
        rows.push({ where: "gitlab", check: "required-status", subject: ctx, expected, found: couldNot(p, SCOPES.gitlab), status: "unknown" });
        continue;
      }
      const must = p.value?.only_allow_merge_if_pipeline_succeeds === true;
      const skipped = p.value?.allow_merge_on_skipped_pipeline === true;
      const found = must ? (skipped ? "pipelines must succeed, but a skipped pipeline may merge" : "pipelines must succeed") : "a merge request may merge with a failed pipeline";
      rows.push({ where: "gitlab", check: "required-status", subject: ctx, expected, found, status: must && !skipped ? "match" : "mismatch" });
    }
  }
  return rows;
}

export async function forgejoRows(fetch: ForgeFetch, t: ForgeTarget, c: ForgeCheckContract): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const r = await read<{ rule_name?: string; branch_name?: string; enable_status_check?: boolean; status_check_contexts?: string[] }[]>(fetch, t, `/repos/${t.repo}/branch_protections`);
  const ruleOf = (b: string) => (r.ok ? (r.value ?? []).find((p) => { const n = p.rule_name || p.branch_name || ""; return n === b || (n !== "" && branchGlob(n, b)); }) : undefined);
  for (const b of protectedBranches(c)) {
    if (!r.ok) {
      rows.push({ where: "forgejo", check: "protected-branch", subject: b, expected: "protected", found: couldNot(r, SCOPES.forgejo), status: "unknown" });
      continue;
    }
    const rule = ruleOf(b);
    const name = rule ? rule.rule_name || rule.branch_name : undefined;
    rows.push({ where: "forgejo", check: "protected-branch", subject: b, expected: "protected", found: name ? `protected by rule ${name}` : "not protected", status: name ? "match" : "mismatch" });
  }
  const branch = c.repository.defaultBranch;
  for (const ctx of c.requiredStatuses ?? []) {
    const expected = `${branch} requires ${ctx} before a merge`;
    if (!r.ok) {
      rows.push({ where: "forgejo", check: "required-status", subject: ctx, expected, found: couldNot(r, SCOPES.forgejo), status: "unknown" });
      continue;
    }
    const rule = ruleOf(branch);
    const patterns = rule?.enable_status_check ? (rule.status_check_contexts ?? []) : [];
    const ok = patterns.some((p) => p === ctx || branchGlob(p, ctx));
    const found = !rule ? `${branch} has no protection rule` : !rule.enable_status_check ? "the rule checks no status" : `required: ${patterns.join(", ") || "none"}`;
    rows.push({ where: "forgejo", check: "required-status", subject: ctx, expected, found, status: ok ? "match" : "mismatch" });
  }
  return rows;
}

/**
 * Whether each required status has been posted on the default branch's
 * head, read with chant's forge client (#4554). A required status no job
 * posts blocks every merge, so its name is worth seeing next to the forge's
 * list. One not posted yet is `unknown`: the pipeline may not have run.
 */
export async function statusReportedRows(fetch: ForgeFetch, t: ForgeTarget, c: ForgeCheckContract): Promise<CheckRow[]> {
  const contexts = c.requiredStatuses ?? [];
  if (!contexts.length) return [];
  const branch = c.repository.defaultBranch;
  const forge = forgeClient(t, fetch);
  let head: string | undefined;
  let posted: string[] | undefined;
  let why: string | undefined;
  try {
    if (forge.branchHead) head = await forge.branchHead(branch);
    else {
      const b = await read<{ commit?: { id?: string } }>(fetch, t, `${projectPath(t)}/repository/branches/${encodeURIComponent(branch)}`);
      head = b.ok ? b.value?.commit?.id : undefined;
    }
    if (head && forge.commitStatuses) posted = (await forge.commitStatuses(head, branch)).map((s) => s.context);
  } catch (e) {
    if (e instanceof ReadOnlyError) throw e;
    why = e instanceof ForgeApiError ? `could not read (${e.status})` : `could not read: ${(e as Error).message}`;
  }
  return contexts.map((ctx): CheckRow => {
    const expected = `${ctx} is posted on ${branch}`;
    if (why) return { where: t.kind, check: "status-reported", subject: ctx, expected, found: why, status: "unknown" };
    if (!head) return { where: t.kind, check: "status-reported", subject: ctx, expected, found: `could not read ${branch}'s head`, status: "unknown" };
    if (!posted) return { where: t.kind, check: "status-reported", subject: ctx, expected, found: "the forge client reads no statuses", status: "unknown" };
    const ok = posted.includes(ctx);
    return { where: t.kind, check: "status-reported", subject: ctx, expected, found: ok ? `posted on ${head.slice(0, 12)}` : `not posted on ${head.slice(0, 12)}${posted.length ? ` (posted: ${posted.join(", ")})` : ""}`, status: ok ? "match" : "unknown" };
  });
}
