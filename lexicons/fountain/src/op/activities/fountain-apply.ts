/**
 * fountain native applier.
 *
 * Direct-REST reconciler against fountain's API (the same surface
 * `fountain apply` uses, but API-first: create-if-new, update-if-changed
 * by name, optional owned-only prune). Input is the serializer's
 * `fountain-plan.json` sidecar — entity name → { kind, spec } — so no
 * YAML parsing happens on the apply side.
 *
 * Apply order is Environment → Vault → Agent: agents reference their
 * environment by entity name in the plan, resolved to the live id here
 * (mirroring the CLI's name→id resolution in apply.go).
 *
 * Secrets: `spec.secrets` entries ({key, value}) are stripped from the
 * resource body and upserted through the secrets sub-resource. Values are
 * write-only upstream, so this is upsert-always — a changed value cannot
 * be detected, only overwritten. (BinaryBourbon/fountain#148's reference
 * model would make this a plain diff; until then, upsert-always is the
 * honest semantic.)
 *
 * Endpoint/token resolution: explicit args win, then FOUNTAIN_ENDPOINT /
 * FOUNTAIN_TOKEN, then the hosted default endpoint.
 */

import { readFileSync } from "node:fs";

export const DEFAULT_FOUNTAIN_BASE_URL = "https://founta.inevitable.fyi";

/** Ownership marker checked by the owned-only prune. */
export const OWNERSHIP_KEY = "managed-by";
export const OWNERSHIP_VALUE = "chant";

const KIND_PATHS: Record<string, string> = {
  Environment: "environments",
  Vault: "vaults",
  Agent: "agents",
};

/** Environments before vaults before agents; prune runs in reverse. */
const APPLY_ORDER = ["Environment", "Vault", "Agent"] as const;

export interface PlanEntry {
  kind: string;
  spec: Record<string, unknown>;
}

export type FountainPlan = Record<string, PlanEntry>;

export interface FountainHttp {
  (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

export interface FountainApplyArgs {
  /** Path to the serializer's fountain-plan.json. */
  planPath?: string;
  /** Inline plan content (takes precedence over planPath). */
  planContent?: string;
  endpoint?: string;
  token?: string;
  /** Delete chant-owned resources absent from the plan. Off by default. */
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

export function parsePlan(content: string): FountainPlan {
  return JSON.parse(content) as FountainPlan;
}

/** Split spec.secrets ({key, value}[]) from the resource body. Pure. */
export function splitSecrets(spec: Record<string, unknown>): {
  body: Record<string, unknown>;
  secrets: Array<{ key: string; value: string }>;
} {
  const { secrets, ...body } = spec;
  if (!Array.isArray(secrets)) return { body: spec, secrets: [] };
  const valid = secrets.filter(
    (s): s is { key: string; value: string } =>
      !!s && typeof s === "object" && typeof (s as { key?: unknown }).key === "string",
  );
  return { body, secrets: valid };
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
  const content = args.planContent ?? readFileSync(args.planPath!, "utf-8");
  const plan = parsePlan(content);

  const endpoint = resolveEndpoint(args);
  const client = http ?? defaultFountainHttp(endpoint, resolveToken(args));

  const summary: FountainApplySummary = { created: [], updated: [], pruned: [], secretsUpserted: 0 };
  const idByKindAndName = new Map<string, string>();
  const live = new Map<string, Map<string, LiveResource>>();
  for (const kind of APPLY_ORDER) {
    live.set(kind, await listByName(client, kind));
  }

  for (const kind of APPLY_ORDER) {
    for (const [entityName, entry] of Object.entries(plan)) {
      if (entry.kind !== kind) continue;

      const { body, secrets } = splitSecrets(entry.spec);
      const payload: Record<string, unknown> = { ...body };
      // Manifest identity: the fountain resource is named after the spec's
      // own `name` when present, else the entity name.
      const resourceName = typeof payload.name === "string" ? (payload.name as string) : entityName;
      payload.name = resourceName;

      // Agent environment ref: the plan carries the referenced *entity*
      // name; resolve through the id map (created this run) or live state.
      if (kind === "Agent" && typeof payload.environment === "string") {
        const refEntity = payload.environment as string;
        const refPlanEntry = plan[refEntity];
        const refResourceName =
          refPlanEntry && typeof refPlanEntry.spec.name === "string"
            ? (refPlanEntry.spec.name as string)
            : refEntity;
        const envId =
          idByKindAndName.get(`Environment/${refEntity}`) ??
          live.get("Environment")?.get(refResourceName)?.id;
        if (!envId) throw new Error(`fountainApply: agent "${entityName}" references unknown environment "${refEntity}"`);
        delete payload.environment;
        payload.environment_id = envId;
      }

      const existing = live.get(kind)!.get(resourceName);
      let id: string;
      if (existing) {
        const { status } = await client("PUT", `/api/${KIND_PATHS[kind]}/${existing.id}`, payload);
        if (status !== 200) throw new Error(`fountainApply: update ${kind} "${resourceName}" failed (${status})`);
        id = existing.id;
        summary.updated.push(`${kind}/${resourceName}`);
      } else {
        const { status, json } = await client("POST", `/api/${KIND_PATHS[kind]}`, payload);
        if (status !== 201 && status !== 200) {
          throw new Error(`fountainApply: create ${kind} "${resourceName}" failed (${status})`);
        }
        id = (json as { data?: { id?: string } })?.data?.id ?? "";
        summary.created.push(`${kind}/${resourceName}`);
      }
      idByKindAndName.set(`${kind}/${entityName}`, id);

      // Secrets sub-resource: upsert-always (values are write-only upstream).
      if (secrets.length > 0 && (kind === "Environment" || kind === "Vault")) {
        for (const secret of secrets) {
          const { status } = await client("POST", `/api/${KIND_PATHS[kind]}/${id}/secrets`, secret);
          if (status !== 200 && status !== 201) {
            throw new Error(`fountainApply: secret upsert on ${kind} "${resourceName}" failed (${status})`);
          }
          summary.secretsUpserted += 1;
        }
      }
    }
  }

  if (args.prune) {
    const planned = new Set<string>();
    for (const [entityName, entry] of Object.entries(plan)) {
      const resourceName =
        typeof entry.spec.name === "string" ? (entry.spec.name as string) : entityName;
      planned.add(`${entry.kind}/${resourceName}`);
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
