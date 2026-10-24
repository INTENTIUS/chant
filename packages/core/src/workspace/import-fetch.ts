/**
 * The network half of `chant workspace init --from tfc|spacelift` (#3178).
 *
 * Reads the Terraform Cloud API or the Spacelift GraphQL API into the input
 * documents `import-source.ts` maps. The transport is a parameter, so a test
 * feeds fixture responses and nothing here is reached without a token. A
 * token is read from `--token`, else `TFE_TOKEN` / `TF_TOKEN_app_terraform_io`
 * for Terraform Cloud and `SPACELIFT_API_TOKEN` for Spacelift. Only reads:
 * every request is a GET, or a GraphQL query with no mutation.
 */

import type { SpaceliftInput, TfcInput } from "./import-source";

export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ImportFetchError extends Error {}

const defaultFetch: Fetcher = (url, init) => fetch(url, init);

// ── Terraform Cloud ──────────────────────────────────────────────────────────

interface JsonApiResource {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string } | { id: string }[] | null }>;
}

export interface TfcFetchOptions {
  organization: string;
  token: string;
  /** Default `https://app.terraform.io`; a Terraform Enterprise host works too. */
  host?: string;
  fetcher?: Fetcher;
}

export async function fetchTfc(options: TfcFetchOptions): Promise<TfcInput> {
  const fetcher = options.fetcher ?? defaultFetch;
  const base = (options.host ?? "https://app.terraform.io").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${options.token}`, "Content-Type": "application/vnd.api+json" };

  const list = async (path: string): Promise<JsonApiResource[]> => {
    const out: JsonApiResource[] = [];
    let url: string | undefined = `${base}/api/v2${path}${path.includes("?") ? "&" : "?"}page%5Bsize%5D=100`;
    while (url) {
      const res = await fetcher(url, { method: "GET", headers });
      if (!res.ok) throw new ImportFetchError(`Terraform Cloud answered ${res.status} for ${url.replace(base, "")}`);
      const body = (await res.json()) as { data?: JsonApiResource[]; links?: { next?: string | null } };
      out.push(...(body.data ?? []));
      url = body.links?.next ?? undefined;
    }
    return out;
  };

  const org = encodeURIComponent(options.organization);
  const [projects, workspaces, policySets] = await Promise.all([list(`/organizations/${org}/projects`), list(`/organizations/${org}/workspaces`), list(`/organizations/${org}/policy-sets`)]);

  const full: TfcInput["workspaces"] = [];
  for (const w of workspaces) {
    const a = w.attributes ?? {};
    const [vars, triggers] = await Promise.all([list(`/workspaces/${w.id}/vars`), list(`/workspaces/${w.id}/run-triggers?filter%5Brun-trigger%5D%5Btype%5D=inbound`)]);
    const project = w.relationships?.project?.data;
    full.push({
      id: w.id,
      name: String(a.name ?? w.id),
      ...(project && !Array.isArray(project) ? { project: project.id } : {}),
      ...(a["working-directory"] ? { workingDirectory: String(a["working-directory"]) } : {}),
      ...(a["terraform-version"] ? { terraformVersion: String(a["terraform-version"]) } : {}),
      ...((a["vcs-repo"] as { identifier?: string } | null)?.identifier ? { vcsRepo: (a["vcs-repo"] as { identifier: string }).identifier } : {}),
      tags: Array.isArray(a["tag-names"]) ? (a["tag-names"] as string[]) : [],
      variables: vars.map((v) => ({ key: String(v.attributes?.key ?? ""), category: String(v.attributes?.category ?? ""), sensitive: v.attributes?.sensitive === true })),
      runTriggers: triggers
        .map((t) => (t.relationships?.sourceable?.data as { id: string } | undefined)?.id)
        .filter((id): id is string => typeof id === "string"),
    });
  }

  return {
    organization: options.organization,
    projects: projects.map((p) => ({ id: p.id, name: String(p.attributes?.name ?? p.id) })),
    workspaces: full,
    policySets: policySets.map((p) => ({
      id: p.id,
      name: String(p.attributes?.name ?? p.id),
      kind: String(p.attributes?.kind ?? "sentinel"),
      global: p.attributes?.global === true,
      workspaces: ((p.relationships?.workspaces?.data as { id: string }[] | undefined) ?? []).map((x) => x.id),
    })),
  };
}

// ── Spacelift ────────────────────────────────────────────────────────────────

export interface SpaceliftFetchOptions {
  /** The account's endpoint, e.g. `https://acme.app.spacelift.io/graphql`. */
  endpoint: string;
  token: string;
  fetcher?: Fetcher;
}

const SPACELIFT_QUERY = `query ChantImport {
  stacks { id name space repository branch projectRoot vendor { __typename } labels
    attachedPolicies: attachedPolicies { id }
    dependsOn: dependencies { stackId references { outputName inputName } } }
  policies { id name type }
}`;

export async function fetchSpacelift(options: SpaceliftFetchOptions): Promise<SpaceliftInput> {
  const fetcher = options.fetcher ?? defaultFetch;
  const res = await fetcher(options.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: SPACELIFT_QUERY }),
  });
  if (!res.ok) throw new ImportFetchError(`Spacelift answered ${res.status} for ${options.endpoint}`);
  const body = (await res.json()) as {
    errors?: { message: string }[];
    data?: {
      stacks?: {
        id: string;
        name: string;
        space?: string;
        repository?: string;
        branch?: string;
        projectRoot?: string;
        vendor?: { __typename?: string } | null;
        labels?: string[];
        attachedPolicies?: { id: string }[];
        dependsOn?: { stackId: string; references?: { outputName: string; inputName?: string }[] }[];
      }[];
      policies?: { id: string; name: string; type?: string }[];
    };
  };
  if (body.errors?.length) throw new ImportFetchError(`Spacelift: ${body.errors.map((e) => e.message).join("; ")}`);
  return {
    account: new URL(options.endpoint).hostname.split(".")[0],
    stacks: (body.data?.stacks ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.space ? { space: s.space } : {}),
      ...(s.repository ? { repository: s.repository } : {}),
      ...(s.branch ? { branch: s.branch } : {}),
      ...(s.projectRoot ? { projectRoot: s.projectRoot } : {}),
      vendor: (s.vendor?.__typename ?? "TerraformStackVendor").replace(/StackVendor$|Vendor$/, "").toLowerCase() || "terraform",
      labels: s.labels ?? [],
      policies: (s.attachedPolicies ?? []).map((p) => p.id),
      dependsOn: (s.dependsOn ?? []).map((d) => ({ stack: d.stackId, references: d.references ?? [] })),
    })),
    policies: body.data?.policies ?? [],
  };
}
