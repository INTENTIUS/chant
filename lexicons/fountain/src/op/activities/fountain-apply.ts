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
 * Prune (opt-in, chant-owned only) isn't part of bulk apply, so it still
 * lists each kind's live state and deletes what's absent from the
 * manifest, same as before.
 *
 * Endpoint/token resolution: explicit args win, then FOUNTAIN_ENDPOINT /
 * FOUNTAIN_TOKEN, then the hosted default endpoint.
 */

import { readFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";

export const DEFAULT_FOUNTAIN_BASE_URL = "https://fountain.inevitable.fyi";

/** Ownership marker checked by the owned-only prune. */
export const OWNERSHIP_KEY = "managed-by";
export const OWNERSHIP_VALUE = "chant";

const KIND_PATHS: Record<string, string> = {
  Environment: "environments",
  Vault: "vaults",
  Agent: "agents",
};

const KINDS = new Set(Object.keys(KIND_PATHS));

/** Prune-only ordering now — bulk apply reconciles create/update order itself. */
const APPLY_ORDER = ["Environment", "Vault", "Agent"] as const;

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
  /** Delete chant-owned resources absent from the manifest. Off by default. */
  prune?: boolean;
}

export interface FountainApplySummary {
  created: string[];
  updated: string[];
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

export async function fountainApply(
  args: FountainApplyArgs,
  http?: FountainHttp,
): Promise<FountainApplySummary> {
  const content = args.manifestContent ?? readFileSync(args.manifestPath!, "utf-8");
  const resources = parseManifest(content);

  const endpoint = resolveEndpoint(args);
  const client = http ?? defaultFountainHttp(endpoint, resolveToken(args));

  const summary: FountainApplySummary = { created: [], updated: [], pruned: [], secretsUpserted: 0 };

  if (resources.length > 0) {
    const body = {
      resources: resources.map((r) => ({ kind: r.kind, name: r.name, spec: toApplyPayload(r.spec) })),
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

  if (args.prune) {
    const planned = new Set(resources.map((r) => `${r.kind}/${r.name}`));
    const live = new Map<string, Map<string, LiveResource>>();
    for (const kind of APPLY_ORDER) {
      live.set(kind, await listByName(client, kind));
    }
    // Reverse order: agents first, then vaults, then environments.
    for (const kind of [...APPLY_ORDER].reverse()) {
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

  return summary;
}
