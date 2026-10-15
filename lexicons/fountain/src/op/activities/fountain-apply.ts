/**
 * fountain native applier.
 *
 * Compiles the serializer's manifest YAML — the same `apiVersion:
 * fountain.dev/v1` documents `fountain apply -f` accepts — into fountain's
 * `POST /api/apply` bulk-apply request and sends it in one call. That
 * endpoint (BinaryBourbon/fountain#151) does the reconciliation server-side:
 * upsert by name, environments -> vaults -> agents, an agent's
 * `spec.environment` name resolved against the manifest or the tenant's
 * existing environments, secrets upserted through the encrypted envelope
 * path. Best-effort per resource — every result is collected before this
 * throws, so one bad resource doesn't hide failures in the rest of the
 * manifest, and a partial apply is never silently reported as clean.
 *
 * The server resolves an agent's `environment` reference by name itself, so
 * the manifest's `spec` passes through with two adjustments. chant's authored
 * `secrets` is an ordered `{key, value}[]` and the wire format wants
 * `{KEY: value}` (see `toApplyPayload`). And `allowed_vault_ids` is authored
 * as vault names — the manifest's reference form — while fountain types the
 * column `{:array, :binary_id}` and passes it straight to the insert, so a
 * name there crashes inside Ecto rather than failing validation (#2166).
 * {@link vaultNameRefs} finds those, and the agents carrying them are sent in
 * a second bulk call, after the vaults they name exist to be looked up.
 *
 * Bulk apply takes Environment, Vault and Agent, and those are the only kinds
 * there are. Teammate, Schedule and Webhook went out through their own routes
 * until Managoat removed the team, its schedules and webhooks
 * (managoat/managoat#2793). The serializer no longer emits them and FTN025
 * fails a build that declares one, so a document of one of those kinds in a
 * hand-written manifest is skipped here rather than sent to a route that
 * answers 404.
 *
 * Prune (opt-in, chant-owned only) isn't part of bulk apply, so it still
 * lists each kind's live state and deletes what's absent from the
 * manifest, same as before.
 *
 * Endpoint/token resolution (#2124): explicit args win; then the
 * `fountain.profiles` entry named by `args.profile` (falling back to
 * `defaultProfile`) read from the project's `chant.config.ts`; then
 * FOUNTAIN_ENDPOINT / FOUNTAIN_TOKEN; then the hosted default endpoint. Once
 * a profile resolves, its own token env var is authoritative — a profile
 * with an unset env var is an actionable error, not a silent fall-through to
 * FOUNTAIN_TOKEN.
 */

import { readFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";
import { loadChantConfig, type ChantConfig } from "@intentius/chant/config";
import { resolveProfile } from "../../config";
import { allowlistOf, allowlistToIds, vaultNameRefs } from "../../allowlist-refs";

export const DEFAULT_FOUNTAIN_BASE_URL = "https://fountain.inevitable.fyi";

/** Ownership marker checked by the owned-only prune. */
export const OWNERSHIP_KEY = "managed-by";
export const OWNERSHIP_VALUE = "chant";

const KIND_PATHS: Record<string, string> = {
  Environment: "environments",
  Vault: "vaults",
  Agent: "agents",
};

/**
 * Kinds `POST /api/apply` reconciles, in dependency order: an Agent names its
 * Environment, so prune walks this backwards. The serializer emits the
 * manifest in the same order (its `KIND_ORDER`).
 */
const KINDS = ["Environment", "Vault", "Agent"] as const;
const KIND_SET: ReadonlySet<string> = new Set(KINDS);

export interface ManifestResource {
  kind: string;
  name: string;
  spec: Record<string, unknown>;
}

export interface FountainHttp {
  (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

export interface FountainApplyArgs {
  /** Path to the serializer's compiled fountain manifest YAML. */
  manifestPath?: string;
  /** Inline manifest YAML content (takes precedence over manifestPath). */
  manifestContent?: string;
  endpoint?: string;
  token?: string;
  /**
   * Named `fountain.profiles` entry to resolve endpoint/token from (#2124).
   * Falls back to `defaultProfile` when omitted; ignored for any field an
   * explicit `endpoint`/`token` arg already supplies.
   */
  profile?: string;
  /** Project root `chant.config.ts` is read from. Default: process.cwd(). */
  cwd?: string;
  /** Delete chant-owned resources absent from the manifest. Off by default. */
  prune?: boolean;
}

/** Injectable seam for testing — production loads the config from disk. */
export interface FountainConnectionDeps {
  /** Pre-loaded project config (skips reading chant.config.ts). */
  config?: ChantConfig;
}

export interface FountainApplySummary {
  created: string[];
  updated: string[];
  /**
   * Resources already matching the manifest, when bulk apply says so. A
   * server that reports only `created` and `updated` leaves this empty.
   */
  unchanged: string[];
  pruned: string[];
  secretsUpserted: number;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

export function resolveEndpoint(
  args: { endpoint?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = args.endpoint || env.FOUNTAIN_ENDPOINT || DEFAULT_FOUNTAIN_BASE_URL;
  return base.replace(/\/$/, "");
}

export function resolveToken(
  args: { token?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = args.token || env.FOUNTAIN_TOKEN;
  if (!token) throw new Error("fountainApply: no token — set FOUNTAIN_TOKEN or pass token");
  return token;
}

/**
 * Resolve the endpoint and token to talk to fountain with (#2124).
 *
 * Explicit `args.endpoint` / `args.token` always win, field by field. For
 * whichever field is missing, this reads the project's `chant.config.ts` and
 * resolves `args.profile` (falling back to `defaultProfile`) through
 * {@link resolveProfile}. When a profile resolves, it is authoritative for
 * the field it covers — a profile whose token env var isn't set throws
 * naming that variable, rather than silently falling through to
 * `FOUNTAIN_TOKEN`. Only when no profile resolves at all does this fall back
 * to the pre-#2124 behavior: `FOUNTAIN_ENDPOINT` / `FOUNTAIN_TOKEN` /
 * `DEFAULT_FOUNTAIN_BASE_URL`.
 */
export async function resolveConnection(
  args: { endpoint?: string; token?: string; profile?: string; cwd?: string },
  deps?: FountainConnectionDeps,
): Promise<{ endpoint: string; token: string }> {
  if (args.endpoint !== undefined && args.token !== undefined) {
    return { endpoint: resolveEndpoint(args), token: args.token };
  }

  const config = deps?.config ?? (await loadChantConfig(args.cwd ?? process.cwd())).config;
  const profile = resolveProfile(config, args.profile);

  if (!profile) {
    return { endpoint: resolveEndpoint(args), token: resolveToken(args) };
  }

  const endpoint = resolveEndpoint({ endpoint: args.endpoint ?? profile.endpoint });
  const token = args.token ?? process.env[profile.token.env];
  if (!token) {
    throw new Error(
      `fountainApply: profile's token environment variable "${profile.token.env}" is not set`,
    );
  }
  return { endpoint, token };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse the serializer's multi-document manifest YAML into apply resources. Pure. */
export function parseManifest(content: string): ManifestResource[] {
  const resources: ManifestResource[] = [];
  for (const docText of content.split(/^---\s*$/m)) {
    if (!docText.trim()) continue;
    const doc = parseYAML(docText);
    const kind = typeof doc.kind === "string" ? doc.kind : "";
    if (!KIND_SET.has(kind)) continue;
    const meta = isRecord(doc.metadata) ? doc.metadata : {};
    const name = typeof meta.name === "string" ? meta.name : "";
    const spec = isRecord(doc.spec) ? doc.spec : {};
    resources.push({ kind, name, spec });
  }
  return resources;
}

/**
 * Fountain's bulk-apply spec takes `secrets` as a `{KEY: value}` map;
 * chant's authored shape is an ordered `{key, value}[]`. Convert only that
 * one field — the rest of spec passes through untouched. Pure.
 */
export function toApplyPayload(spec: Record<string, unknown>): Record<string, unknown> {
  const { secrets, ...rest } = spec;
  if (!Array.isArray(secrets)) return spec;
  const map: Record<string, string> = {};
  for (const entry of secrets) {
    if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
      map[(entry as { key: string }).key] = String((entry as { value?: unknown }).value ?? "");
    }
  }
  return { ...rest, secrets: map };
}

/**
 * The rule for which `allowed_vault_ids` entries are names, re-exported from
 * where it used to be defined (#2166). It now lives in ../../allowlist-refs,
 * next to the read direction that has to agree with it (#2176).
 */
export { vaultNameRefs };

/** Is a live resource chant-owned (by its metadata marker)? Pure. */
export function isChantOwned(resource: { metadata?: unknown }): boolean {
  const meta = resource.metadata;
  if (!meta || typeof meta !== "object") return false;
  return (meta as Record<string, unknown>)[OWNERSHIP_KEY] === OWNERSHIP_VALUE;
}

// ── HTTP ──────────────────────────────────────────────────────────────────

/**
 * The fetch-backed client. `signal`, when given, rides on every request, so an
 * aborted Op step (timeout or Ctrl-C) cancels the request in flight.
 */
export function defaultFountainHttp(endpoint: string, token: string, signal?: AbortSignal): FountainHttp {
  return async (method, path, body) => {
    const res = await fetch(`${endpoint}${path}`, {
      method,
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // 204s and empty bodies are fine.
    }
    return { status: res.status, json };
  };
}

/**
 * `http`, refusing to start a request once `signal` has fired. The fetch-backed
 * client already cancels a request in flight; this also stops an injected
 * client between requests, so an aborted step makes no further call.
 */
export function abortable(http: FountainHttp, signal?: AbortSignal): FountainHttp {
  if (!signal) return http;
  return (method, path, body) => {
    signal.throwIfAborted();
    return http(method, path, body);
  };
}

// ── Applier ───────────────────────────────────────────────────────────────

interface LiveResource {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
}

interface ApplyResultSecret {
  key: string;
  action: string;
  errors?: Record<string, unknown> | null;
}

interface ApplyResult {
  kind: string;
  name: string;
  action: string;
  errors?: Record<string, unknown> | null;
  secrets?: ApplyResultSecret[];
}

async function listByName(http: FountainHttp, kind: string): Promise<Map<string, LiveResource>> {
  const { status, json } = await http("GET", `/api/${KIND_PATHS[kind]}`);
  if (status !== 200) throw new Error(`fountainApply: list ${kind} failed (${status})`);
  const data = (json as { data?: LiveResource[] })?.data ?? [];
  return new Map(data.map((r) => [r.name, r]));
}

/** Vault ids by name, listed at most once per apply. */
class VaultIds {
  private vaults?: Map<string, LiveResource>;

  constructor(private readonly http: FountainHttp) {}

  /** The vault's id, or nothing when this fountain has no vault by that name. */
  async knownVaultId(name: string): Promise<string | undefined> {
    this.vaults ??= await listByName(this.http, "Vault");
    return this.vaults.get(name)?.id;
  }
}

/**
 * The same resource with its `allowed_vault_ids` names replaced by uuids (#2166).
 *
 * A uuid already in the list is left alone, so a hand-written manifest that
 * carries ids keeps working. A name no vault answers to fails here, naming the
 * agent and the name — fountain would otherwise pass it to the insert and die
 * with an `Ecto.ChangeError` behind a bare 500 that drops the connection.
 */
async function withResolvedVaultIds(
  ids: VaultIds,
  resource: ManifestResource,
): Promise<ManifestResource> {
  const entries = allowlistOf(resource.spec, "allowed_vault_ids");
  if (!entries || vaultNameRefs(resource.spec).length === 0) return resource;

  const resolved = await allowlistToIds(entries, async (name) => {
    const id = await ids.knownVaultId(name);
    if (!id) {
      throw new Error(
        `fountainApply: ${resource.kind}/${resource.name}: allowed_vault_ids names the vault ` +
          `"${name}", which does not exist on this fountain. Declare that Vault in the same ` +
          `manifest, or point the reference at one that is already there.`,
      );
    }
    return id;
  });
  return { ...resource, spec: { ...resource.spec, allowed_vault_ids: resolved } };
}

/**
 * One `POST /api/apply` call, folded into the summary.
 *
 * Every result is collected before this throws, so one bad resource does not
 * hide failures in the rest of the batch.
 */
async function sendBulk(
  client: FountainHttp,
  batch: ManifestResource[],
  summary: FountainApplySummary,
): Promise<void> {
  const body = {
    resources: batch.map((r) => ({ kind: r.kind, name: r.name, spec: toApplyPayload(r.spec) })),
  };
  const { status, json } = await client("POST", "/api/apply", body);
  if (status !== 200) {
    throw new Error(`fountainApply: POST /api/apply failed (${status})`);
  }
  const results = (json as { data?: { results?: ApplyResult[] } })?.data?.results ?? [];

  const failures: string[] = [];
  for (const r of results) {
    const label = `${r.kind}/${r.name}`;
    if (r.action === "created") summary.created.push(label);
    else if (r.action === "updated") summary.updated.push(label);
    else if (r.action === "unchanged") summary.unchanged.push(label);
    else failures.push(`${label}: ${JSON.stringify(r.errors)}`);

    for (const s of r.secrets ?? []) {
      if (s.action === "upserted") summary.secretsUpserted += 1;
      else failures.push(`${label} secret "${s.key}": ${JSON.stringify(s.errors)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`fountainApply: ${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
  }
}

/**
 * Apply a fountain manifest. The Op activity contract (`ActivityFn`, #2775):
 * the executor calls `fountainApply(args, signal)`, so the second parameter is
 * the step's `AbortSignal` and nothing else. The HTTP client and connection
 * deps are test seams, after it, as every other lexicon's activities take them.
 */
export async function fountainApply(
  args: FountainApplyArgs,
  signal?: AbortSignal,
  http?: FountainHttp,
  deps?: FountainConnectionDeps,
): Promise<FountainApplySummary> {
  const content = args.manifestContent ?? readFileSync(args.manifestPath!, "utf-8");
  const resources = parseManifest(content);

  let client = http;
  if (!client) {
    const { endpoint, token } = await resolveConnection(args, deps);
    client = defaultFountainHttp(endpoint, token, signal);
  }
  client = abortable(client, signal);

  const summary: FountainApplySummary = {
    created: [],
    updated: [],
    unchanged: [],
    pruned: [],
    secretsUpserted: 0,
  };

  const ids = new VaultIds(client);

  // A resource whose `allowed_vault_ids` names a vault goes out in a second
  // bulk call (#2166): the vault it names is usually declared in this same
  // manifest, so the id it resolves to only exists once the first call has
  // created it. Without such a reference this is one call, as before.
  const needsVaultIds = (r: ManifestResource): boolean => vaultNameRefs(r.spec).length > 0;
  const batches = resources.some(needsVaultIds)
    ? [resources.filter((r) => !needsVaultIds(r)), resources.filter(needsVaultIds)]
    : [resources];

  for (const batch of batches) {
    if (batch.length === 0) continue;
    const prepared: ManifestResource[] = [];
    for (const resource of batch) prepared.push(await withResolvedVaultIds(ids, resource));
    await sendBulk(client, prepared, summary);
  }

  if (args.prune) {
    await prune(client, resources, summary);
  }

  return summary;
}

/**
 * Delete what chant owns and the manifest no longer declares. Ownership is the
 * `managed-by: chant` marker.
 */
async function prune(
  client: FountainHttp,
  resources: ManifestResource[],
  summary: FountainApplySummary,
): Promise<void> {
  const planned = new Set(resources.map((r) => `${r.kind}/${r.name}`));

  const live = new Map<string, Map<string, LiveResource>>();
  for (const kind of KINDS) {
    live.set(kind, await listByName(client, kind));
  }
  // Reverse order: agents first, then vaults, then environments.
  for (const kind of [...KINDS].reverse()) {
    for (const [name, resource] of live.get(kind)!) {
      if (planned.has(`${kind}/${name}`)) continue;
      if (!isChantOwned(resource)) continue;
      const { status } = await client("DELETE", `/api/${KIND_PATHS[kind]}/${resource.id}`);
      if (status !== 204 && status !== 200) {
        throw new Error(`fountainApply: prune ${kind} "${name}" failed (${status})`);
      }
      summary.pruned.push(`${kind}/${name}`);
    }
  }
}
