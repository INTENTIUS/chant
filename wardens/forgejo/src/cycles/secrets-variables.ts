/**
 * Secrets & variables cycle — Forgejo Actions org/repo secrets and variables.
 *
 * Secrets are write-only: warden reconciles *presence* (it can list names and
 * delete, but never reads a value — and only writes a value when the operator
 * supplies one out-of-band; this cycle manages presence/removal). Variables are
 * not secret, so their values are reconciled fully.
 *
 *   fetchLive    — org + per-repo secrets (names) and variables (name+value)
 *   buildDesired — config secrets/variables at org and repo scope
 *   apply        — PUT/DELETE the relevant Forgejo Actions endpoint
 *
 * Endpoints:
 *   org secret    PUT/DELETE /orgs/{org}/actions/secrets/{name}
 *   org variable  POST/PUT/DELETE /orgs/{org}/actions/variables/{name}
 *   repo secret   PUT/DELETE /repos/{org}/{repo}/actions/secrets/{name}
 *   repo variable POST/PUT/DELETE /repos/{org}/{repo}/actions/variables/{name}
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig, VariableConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState, LiveRepo, LiveSecret, LiveVariable } from "../reconcile/live.js";
import { charge, paginate } from "./_shared.js";

export type SecretsVariablesScope = Record<string, never>;

interface GhSecret {
  name?: string;
}
interface GhVariable {
  name?: string;
  data?: string;
  value?: string;
}
interface GhRepo {
  name?: string;
}

function mapSecrets(raws: GhSecret[]): LiveSecret[] {
  return raws.filter((s): s is { name: string } => typeof s.name === "string").map((s) => ({ name: s.name }));
}
function mapVariables(raws: GhVariable[]): LiveVariable[] {
  return raws
    .filter((v): v is GhVariable & { name: string } => typeof v.name === "string")
    .map((v) => ({ name: v.name, value: v.data ?? v.value }));
}

export const secretsVariablesCycle: Cycle<SecretsVariablesScope> = {
  name: "secrets-variables",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: SecretsVariablesScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    const secrets = mapSecrets(await paginate<GhSecret>(client, `/orgs/${scopeId}/actions/secrets`, budget));
    const variables = mapVariables(await paginate<GhVariable>(client, `/orgs/${scopeId}/actions/variables`, budget));

    const orgRepos = await paginate<GhRepo>(client, `/orgs/${scopeId}/repos`, budget);
    const repos: Record<string, LiveRepo> = {};
    for (const r of orgRepos) {
      if (!r.name) continue;
      const rs = mapSecrets(await paginate<GhSecret>(client, `/repos/${scopeId}/${r.name}/actions/secrets`, budget));
      const rv = mapVariables(await paginate<GhVariable>(client, `/repos/${scopeId}/${r.name}/actions/variables`, budget));
      repos[r.name] = { secrets: rs, variables: rv };
    }
    return { secrets, variables, repos };
  },

  buildDesired(orgConfig: OrgConfig): OrgConfig {
    const out: OrgConfig = {};
    if (orgConfig.secrets !== undefined) out.secrets = orgConfig.secrets;
    if (orgConfig.variables !== undefined) out.variables = orgConfig.variables;
    if (orgConfig.repos) {
      const repos: Record<string, { secrets?: typeof orgConfig.secrets; variables?: typeof orgConfig.variables }> = {};
      for (const [name, rc] of Object.entries(orgConfig.repos)) {
        const slice: { secrets?: typeof orgConfig.secrets; variables?: typeof orgConfig.variables } = {};
        if (rc.secrets !== undefined) slice.secrets = rc.secrets;
        if (rc.variables !== undefined) slice.variables = rc.variables;
        if (Object.keys(slice).length) repos[name] = slice;
      }
      if (Object.keys(repos).length) out.repos = repos;
    }
    return out;
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: SecretsVariablesScope,
    budget: RateBudget,
  ): Promise<void> {
    const { resourceType, kind, key } = entry;

    // Repo-scoped keys are `${repo}/${name}`; org-scoped keys are just `${name}`.
    const repoScoped = resourceType === "repo-secret" || resourceType === "repo-variable";
    let repo = "";
    let name = key;
    if (repoScoped) {
      const slash = key.indexOf("/");
      repo = key.slice(0, slash);
      name = key.slice(slash + 1);
    }

    const isSecret = resourceType === "org-secret" || resourceType === "repo-secret";
    const isVariable = resourceType === "org-variable" || resourceType === "repo-variable";
    if (!isSecret && !isVariable) return;

    const base = repoScoped
      ? `/repos/${scopeId}/${repo}/actions`
      : `/orgs/${scopeId}/actions`;
    const path = `${base}/${isSecret ? "secrets" : "variables"}/${encodeURIComponent(name)}`;

    if (kind === "delete") {
      charge(budget);
      await client.request("DELETE", path);
      return;
    }

    if (isVariable) {
      const value = (entry.after as VariableConfig | undefined)?.value ?? "";
      charge(budget);
      // POST creates, PUT updates — create vs update mirrors the change kind.
      await client.request(kind === "create" ? "POST" : "PUT", path, { value });
      return;
    }

    // Secret presence: PUT is create-or-update. Value comes from the
    // environment (never config); absent → empty placeholder the operator
    // is expected to set. We only ensure the secret exists.
    const envValue = process.env[`FORGEJO_SECRET_${name}`] ?? "";
    charge(budget);
    await client.request("PUT", path, { data: envValue });
  },
};
