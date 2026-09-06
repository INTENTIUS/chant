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
 * No id resolution happens here anymore: since the server resolves an
 * agent's `environment` reference by name itself, the manifest's `spec`
 * passes through unmodified except for one shape adjustment — chant's
 * authored `secrets` is an ordered `{key, value}[]`, the wire format wants
 * `{KEY: value}` (see `toApplyPayload`).
 *
 * The three v0.16.0 kinds — Teammate, Schedule, Webhook — are not in bulk
 * apply yet (BinaryBourbon/fountain#1636), so each is reconciled against its
 * own routes after the bulk call: `POST`/`PATCH /api/team[/:agent_id]`,
 * `POST`/`PATCH /api/team/:agent_id/schedules[/:id]` matched by name, and
 * `POST`/`PATCH /api/webhooks[/:id]` matched by url. Which kinds take which
 * path is one constant ({@link BULK_APPLY_KINDS}); when #1636 ships they move
 * into it, the bulk call carries all six, and the routes become the fallback
 * an older server falls through to rather than a second code path.
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
 * Kinds `POST /api/apply` reconciles server-side today.
 *
 * BinaryBourbon/fountain#1636 adds Teammate, Schedule and Webhook to bulk
 * apply. When it ships they join this set and the bulk call carries all six —
 * and a server that predates it answers with no result for the three it does
 * not know, which drops each of them onto {@link ROUTED_KINDS}' per-route
 * path below. So the routes are the ordinary path today and the compatibility
 * path afterwards, rather than a second implementation that has to be kept in
 * step with the first.
 */
const BULK_APPLY_KINDS = new Set(["Environment", "Vault", "Agent"]);

/** Kinds this applier can reconcile through their own REST routes. */
const ROUTED_KINDS = new Set(["Teammate", "Schedule", "Webhook"]);

const KINDS = new Set([...BULK_APPLY_KINDS, ...ROUTED_KINDS]);

/**
 * Dependency order — a Teammate names an Agent and a Schedule names a
 * Teammate, so the routed kinds go out in this order and prune walks it
 * backwards. The serializer emits the manifest in the same order (its
 * `KIND_ORDER`), so this is a guard against a hand-edited file rather than
 * a reordering of chant's own output.
 */
const APPLY_ORDER = ["Environment", "Vault", "Agent", "Teammate", "Schedule", "Webhook"] as const;

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
   * Resources already matching the manifest — the routed kinds only.
   *
   * Bulk apply reports `created` or `updated` and nothing else, so an
   * Environment that changed in no way still lands in `updated`; the per-route
   * reconcilers below compare before they write, so they can say. A second
   * apply of an unchanged manifest is the case this exists for.
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
    if (!KINDS.has(kind)) continue;
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

/** Is a live resource chant-owned (by its metadata marker)? Pure. */
export function isChantOwned(resource: { metadata?: unknown }): boolean {
  const meta = resource.metadata;
  if (!meta || typeof meta !== "object") return false;
  return (meta as Record<string, unknown>)[OWNERSHIP_KEY] === OWNERSHIP_VALUE;
}

// ── HTTP ──────────────────────────────────────────────────────────────────

export function defaultFountainHttp(endpoint: string, token: string): FountainHttp {
  return async (method, path, body) => {
    const res = await fetch(`${endpoint}${path}`, {
      method,
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

// ── The per-route path (Teammate, Schedule, Webhook) ──────────────────────
//
// Bulk apply does not carry these kinds yet (BinaryBourbon/fountain#1636), so
// each is reconciled against its own routes: read what is live, compare it to
// the manifest, write only the difference. Every write is keyed on something
// the manifest owns — a teammate on its agent, a schedule on its teammate plus
// its name, a webhook on its url — so a second apply of an unchanged manifest
// makes no writes at all.

/** One teammate on the roster, as `GET /api/team` returns it. */
interface LiveTeammate {
  agent_id: string;
  name?: string;
  agent?: { id?: string; name?: string; metadata?: Record<string, unknown> };
}

/** One schedule on a teammate, as `GET /api/team/:agent_id/schedules` returns it. */
interface LiveSchedule {
  id: string;
  name?: string | null;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
  one_off?: boolean;
}

/** One webhook endpoint, as `GET /api/webhooks` returns it. */
interface LiveWebhook {
  id: string;
  url: string;
  event_types?: string[];
  description?: string | null;
}

function listOf<T>(json: unknown): T[] {
  return (json as { data?: T[] })?.data ?? [];
}

function stringProp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The name a routed resource reconciles by: its spec's, else the manifest's. */
function reconcileName(resource: ManifestResource): string {
  return stringProp(resource.spec.name) ?? resource.name;
}

/** Same members, order ignored — `event_types` is a set on the wire. */
function sameSet(a: unknown, b: unknown): boolean {
  const left = Array.isArray(a) ? [...a].map(String).sort() : undefined;
  const right = Array.isArray(b) ? [...b].map(String).sort() : undefined;
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Name references in a routed spec, resolved to the ids the routes want.
 *
 * The manifest carries names because that is what it is for — a document a
 * person reads and `fountain apply -f` accepts. Bulk apply resolves them
 * server-side; the per-route calls take uuids, so this is the one place that
 * translation happens, over lists fetched at most once each.
 */
class RouteIds {
  private agents?: Map<string, LiveResource>;
  private environments?: Map<string, LiveResource>;
  private vaults?: Map<string, LiveResource>;
  private team?: LiveTeammate[];

  constructor(
    private readonly http: FountainHttp,
    /** Manifest Teammates by name, so a Schedule's `teammate` finds its agent. */
    private readonly teammates: Map<string, ManifestResource>,
  ) {}

  async agentId(name: string): Promise<string> {
    this.agents ??= await listByName(this.http, "Agent");
    const hit = this.agents.get(name);
    if (!hit) throw new Error(`fountainApply: no agent named "${name}"`);
    return hit.id;
  }

  async environmentId(name: string): Promise<string> {
    this.environments ??= await listByName(this.http, "Environment");
    const hit = this.environments.get(name);
    if (!hit) throw new Error(`fountainApply: no environment named "${name}"`);
    return hit.id;
  }

  async vaultId(name: string): Promise<string> {
    this.vaults ??= await listByName(this.http, "Vault");
    const hit = this.vaults.get(name);
    if (!hit) throw new Error(`fountainApply: no vault named "${name}"`);
    return hit.id;
  }

  async roster(): Promise<LiveTeammate[]> {
    if (!this.team) {
      const { status, json } = await this.http("GET", "/api/team");
      if (status !== 200) throw new Error(`fountainApply: list Teammate failed (${status})`);
      this.team = listOf<LiveTeammate>(json);
    }
    return this.team;
  }

  /** Forget the roster, so the next read sees a teammate this apply just added. */
  invalidateRoster(): void {
    this.team = undefined;
  }

  /**
   * The agent id a Schedule's `teammate` reference points at.
   *
   * The manifest's own Teammate is the first answer — it is being applied in
   * the same call, and it names the agent outright. A schedule hung on a
   * teammate that was added by hand falls through to the roster, matched on
   * the teammate's display name.
   */
  async teammateAgentId(teammateName: string): Promise<string> {
    const declared = this.teammates.get(teammateName);
    const agentName = declared ? stringProp(declared.spec.agent) : undefined;
    if (agentName) return this.agentId(agentName);

    const live = (await this.roster()).find(
      (t) => t.name === teammateName || t.agent?.name === teammateName,
    );
    if (!live) throw new Error(`fountainApply: no teammate named "${teammateName}"`);
    return live.agent_id;
  }
}

async function applyTeammate(
  http: FountainHttp,
  ids: RouteIds,
  resource: ManifestResource,
  summary: FountainApplySummary,
): Promise<void> {
  const label = `Teammate/${resource.name}`;
  const agentName = stringProp(resource.spec.agent);
  if (!agentName) throw new Error(`fountainApply: ${label} names no agent`);
  const agentId = await ids.agentId(agentName);
  const wanted = reconcileName(resource);

  const live = (await ids.roster()).find((t) => t.agent_id === agentId);
  if (live) {
    // `PATCH /api/team/:agent_id` renames and nothing else — the environment
    // and vault are fixed when the team conversation opens. A steward that has
    // to move to another environment is removed and re-added, which is the
    // honest shape of that change rather than a silent no-op.
    if ((live.name ?? "") === wanted) {
      summary.unchanged.push(label);
      return;
    }
    const { status } = await http("PATCH", `/api/team/${agentId}`, { name: wanted });
    if (status !== 200) throw new Error(`fountainApply: rename ${label} failed (${status})`);
    summary.updated.push(label);
    return;
  }

  const body: Record<string, unknown> = { agent_id: agentId, name: wanted };
  const environment = stringProp(resource.spec.environment);
  if (environment) body.environment_id = await ids.environmentId(environment);
  const vault = stringProp(resource.spec.vault);
  if (vault) body.vault_id = await ids.vaultId(vault);

  const { status } = await http("POST", "/api/team", body);
  if (status === 201) summary.created.push(label);
  else if (status === 200) summary.unchanged.push(label);
  else throw new Error(`fountainApply: add ${label} failed (${status})`);
  ids.invalidateRoster();
}

async function applySchedule(
  http: FountainHttp,
  ids: RouteIds,
  resource: ManifestResource,
  summary: FountainApplySummary,
): Promise<void> {
  const label = `Schedule/${resource.name}`;
  const teammate = stringProp(resource.spec.teammate);
  if (!teammate) throw new Error(`fountainApply: ${label} names no teammate`);
  const agentId = await ids.teammateAgentId(teammate);
  const wanted = reconcileName(resource);

  const desired: Record<string, unknown> = {
    name: wanted,
    cron: resource.spec.cron,
    prompt: resource.spec.prompt,
    one_off: resource.spec.one_off ?? false,
    enabled: resource.spec.enabled ?? true,
  };

  const { status: listStatus, json } = await http("GET", `/api/team/${agentId}/schedules`);
  if (listStatus !== 200) throw new Error(`fountainApply: list Schedule failed (${listStatus})`);
  const live = listOf<LiveSchedule>(json).find((s) => (s.name ?? "") === wanted);

  if (!live) {
    const { status } = await http("POST", `/api/team/${agentId}/schedules`, desired);
    if (status !== 201 && status !== 200) {
      throw new Error(`fountainApply: create ${label} failed (${status})`);
    }
    summary.created.push(label);
    return;
  }

  const drifted = Object.entries(desired).some(
    ([key, value]) => (live as unknown as Record<string, unknown>)[key] !== value,
  );
  if (!drifted) {
    summary.unchanged.push(label);
    return;
  }
  const { status } = await http("PATCH", `/api/team/${agentId}/schedules/${live.id}`, desired);
  if (status !== 200) throw new Error(`fountainApply: update ${label} failed (${status})`);
  summary.updated.push(label);
}

async function applyWebhook(
  http: FountainHttp,
  resource: ManifestResource,
  summary: FountainApplySummary,
): Promise<void> {
  const label = `Webhook/${resource.name}`;
  const url = stringProp(resource.spec.url);
  if (!url) throw new Error(`fountainApply: ${label} names no url`);

  const { status: listStatus, json } = await http("GET", "/api/webhooks");
  if (listStatus !== 200) throw new Error(`fountainApply: list Webhook failed (${listStatus})`);
  const live = listOf<LiveWebhook>(json).find((w) => w.url === url);

  const body: Record<string, unknown> = { url };
  if (resource.spec.event_types !== undefined) body.event_types = resource.spec.event_types;
  if (resource.spec.description !== undefined) body.description = resource.spec.description;

  if (!live) {
    const { status } = await http("POST", "/api/webhooks", body);
    if (status !== 201 && status !== 200) {
      throw new Error(`fountainApply: create ${label} failed (${status})`);
    }
    summary.created.push(label);
    return;
  }

  // `event_types` absent from the manifest means "whatever fountain defaults
  // to", not "none", so an unset field is never read as drift.
  const typesDrifted =
    resource.spec.event_types !== undefined && !sameSet(live.event_types, resource.spec.event_types);
  const descriptionDrifted =
    resource.spec.description !== undefined &&
    (live.description ?? undefined) !== resource.spec.description;
  if (!typesDrifted && !descriptionDrifted) {
    summary.unchanged.push(label);
    return;
  }
  const { status } = await http("PATCH", `/api/webhooks/${live.id}`, body);
  if (status !== 200) throw new Error(`fountainApply: update ${label} failed (${status})`);
  summary.updated.push(label);
}

export async function fountainApply(
  args: FountainApplyArgs,
  http?: FountainHttp,
  deps?: FountainConnectionDeps,
): Promise<FountainApplySummary> {
  const content = args.manifestContent ?? readFileSync(args.manifestPath!, "utf-8");
  const resources = parseManifest(content);

  let client = http;
  if (!client) {
    const { endpoint, token } = await resolveConnection(args, deps);
    client = defaultFountainHttp(endpoint, token);
  }

  const summary: FountainApplySummary = {
    created: [],
    updated: [],
    unchanged: [],
    pruned: [],
    secretsUpserted: 0,
  };

  // What the bulk call reported on, so a kind it did not answer for falls
  // through to its own routes. Today that is every Teammate, Schedule and
  // Webhook; after #1636 it is only the ones an older server dropped.
  const reported = new Set<string>();

  const bulk = resources.filter((r) => BULK_APPLY_KINDS.has(r.kind));
  if (bulk.length > 0) {
    const body = {
      resources: bulk.map((r) => ({ kind: r.kind, name: r.name, spec: toApplyPayload(r.spec) })),
    };
    const { status, json } = await client("POST", "/api/apply", body);
    if (status !== 200) {
      throw new Error(`fountainApply: POST /api/apply failed (${status})`);
    }
    const results = (json as { data?: { results?: ApplyResult[] } })?.data?.results ?? [];

    const failures: string[] = [];
    for (const r of results) {
      const label = `${r.kind}/${r.name}`;
      reported.add(label);
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

  const teammates = new Map(
    resources.filter((r) => r.kind === "Teammate").map((r) => [reconcileName(r), r]),
  );
  const routed = resources.filter(
    (r) => ROUTED_KINDS.has(r.kind) && !reported.has(`${r.kind}/${r.name}`),
  );
  if (routed.length > 0) {
    const ids = new RouteIds(client, teammates);
    for (const kind of APPLY_ORDER) {
      for (const resource of routed.filter((r) => r.kind === kind)) {
        if (kind === "Teammate") await applyTeammate(client, ids, resource, summary);
        else if (kind === "Schedule") await applySchedule(client, ids, resource, summary);
        else if (kind === "Webhook") await applyWebhook(client, resource, summary);
      }
    }
  }

  if (args.prune) {
    await prune(client, resources, teammates, summary);
  }

  return summary;
}

/**
 * Delete what chant owns and the manifest no longer declares.
 *
 * Ownership is the `managed-by: chant` marker, and the three routed kinds do
 * not carry metadata of their own — so a Teammate's owner is the Agent it
 * binds, and a Schedule's is the teammate it hangs on. A Webhook has neither a
 * marker nor an owner to inherit one from, so nothing prunes it: removing a
 * delivery endpoint chant cannot prove it created is a worse failure than
 * leaving one behind, and `chant lifecycle diff --live` reports it either way.
 */
async function prune(
  client: FountainHttp,
  resources: ManifestResource[],
  teammates: Map<string, ManifestResource>,
  summary: FountainApplySummary,
): Promise<void> {
  const planned = new Set(resources.map((r) => `${r.kind}/${r.name}`));
  const ids = new RouteIds(client, teammates);

  // Schedules first, then teammates, then the bulk kinds in reverse: nothing
  // is deleted before the thing that points at it.
  const roster = await ids.roster();
  const ownedTeammates = roster.filter((t) => isChantOwned({ metadata: t.agent?.metadata }));

  const plannedSchedules = new Set(
    resources.filter((r) => r.kind === "Schedule").map((r) => reconcileName(r)),
  );
  for (const teammate of ownedTeammates) {
    const { status, json } = await client("GET", `/api/team/${teammate.agent_id}/schedules`);
    if (status !== 200) throw new Error(`fountainApply: list Schedule failed (${status})`);
    for (const schedule of listOf<LiveSchedule>(json)) {
      const name = schedule.name ?? "";
      if (plannedSchedules.has(name)) continue;
      const { status: del } = await client(
        "DELETE",
        `/api/team/${teammate.agent_id}/schedules/${schedule.id}`,
      );
      if (del !== 204 && del !== 200) {
        throw new Error(`fountainApply: prune Schedule "${name}" failed (${del})`);
      }
      summary.pruned.push(`Schedule/${name}`);
    }
  }

  const plannedTeammates = new Set(
    resources.filter((r) => r.kind === "Teammate").map((r) => reconcileName(r)),
  );
  for (const teammate of ownedTeammates) {
    const name = teammate.name ?? teammate.agent?.name ?? "";
    if (plannedTeammates.has(name)) continue;
    const { status } = await client("DELETE", `/api/team/${teammate.agent_id}`);
    if (status !== 204 && status !== 200) {
      throw new Error(`fountainApply: prune Teammate "${name}" failed (${status})`);
    }
    summary.pruned.push(`Teammate/${name}`);
  }

  const bulkKinds = APPLY_ORDER.filter((k) => BULK_APPLY_KINDS.has(k));
  const live = new Map<string, Map<string, LiveResource>>();
  for (const kind of bulkKinds) {
    live.set(kind, await listByName(client, kind));
  }
  // Reverse order: agents first, then vaults, then environments.
  for (const kind of [...bulkKinds].reverse()) {
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
