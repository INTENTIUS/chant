/**
 * Live export — read fountain resources back as import IR for
 * `chant import --from`. The adoption path: an org with UI-built
 * environments, vaults, agents, teammates, schedules and webhooks gets typed
 * leaf files.
 *
 * Server-written fields are stripped to the authored shape, and every
 * server-resolved id is put back into the vocabulary an author writes: an
 * agent's `environment_id` becomes the environment's name, a teammate's
 * `environment_id` / `vault_id` the same, a schedule's `agent_id` the name of
 * the teammate whose thread it runs on. Secret *values* never leave fountain
 * (write-only upstream) and secret *keys* cannot round-trip into typed code
 * yet — the request schema has no secrets field (they are a sub-resource;
 * fountain#148's reference model would change this) — so environments export
 * without their secrets and the caller is warned per environment that carries
 * any.
 *
 * The three team-side kinds need a logical id chant can name a `const` after,
 * and only a teammate has an obvious one. A schedule's `name` is optional and
 * unique only within its teammate, so it is qualified by the teammate; a
 * webhook has no name at all, so its url is slugified. Both are the same
 * identity the readers key on (./live-identity.ts), spelled for a variable
 * name.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import type { ResourceIR } from "@intentius/chant/import/parser";
import {
  resolveEndpoint,
  defaultFountainHttp,
  isChantOwned,
  type FountainHttp,
} from "./op/activities/fountain-apply";
import { SERVER_FIELDS } from "./import/parser";
import { FOUNTAIN_KIND_SERVER_FIELDS } from "./deep-observe-hooks";

const KINDS: Array<{ type: string; path: string; kind: string }> = [
  { type: "Fountain::V1::Environment", path: "environments", kind: "Environment" },
  { type: "Fountain::V1::Vault", path: "vaults", kind: "Vault" },
  { type: "Fountain::V1::Agent", path: "agents", kind: "Agent" },
  { type: "Fountain::V1::Teammate", path: "team", kind: "Teammate" },
  { type: "Fountain::V1::Schedule", path: "team/schedules", kind: "Schedule" },
  { type: "Fountain::V1::Webhook", path: "webhooks", kind: "Webhook" },
];

/** Read-only fields no request schema accepts, beyond the shared `SERVER_FIELDS`. */
const READ_ONLY: Record<string, ReadonlySet<string>> = {
  Teammate: new Set(["agent", "conversation", ...(FOUNTAIN_KIND_SERVER_FIELDS["Fountain::V1::Teammate"] ?? [])]),
  Schedule: FOUNTAIN_KIND_SERVER_FIELDS["Fountain::V1::Schedule"] ?? new Set(),
  Webhook: new Set(["status", ...(FOUNTAIN_KIND_SERVER_FIELDS["Fountain::V1::Webhook"] ?? [])]),
};

export interface ExportResourcesOptions {
  environment: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
  endpoint?: string;
  /** Injectable for tests. */
  http?: FountainHttp;
  /** Warning sink (defaults to console.error). */
  warn?: (msg: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A url reduced to something that reads as a variable name: `example-com-hooks-fountain`. */
export function webhookLogicalId(url: string): string {
  const slug = url
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug ? `webhook-${slug}` : "webhook";
}

export async function exportResources(options: ExportResourcesOptions): Promise<ExportedTemplate> {
  const warn = options.warn ?? ((msg: string) => console.error(`[fountain] ${msg}`));
  const token = process.env.FOUNTAIN_TOKEN;
  const http =
    options.http ??
    defaultFountainHttp(resolveEndpoint({ endpoint: options.endpoint }), token ?? "");
  if (!options.http && !token) {
    throw new Error("fountain export: FOUNTAIN_TOKEN is not set");
  }

  const resources: ResourceIR[] = [];
  const envNameById = new Map<string, string>();
  const vaultNameById = new Map<string, string>();
  const agentNameById = new Map<string, string>();
  const agentOwned = new Map<string, boolean>();
  // agent_id → the teammate's name, so a schedule can name the teammate it
  // belongs to rather than repeat the id its route carries.
  const teammateByAgentId = new Map<string, string>();

  // A kind is listed when the selector wants it, and also when something the
  // selector wants resolves a reference through it: the id → name maps below
  // are what turn a server-resolved reference back into the name an author
  // writes, and exporting only schedules must not produce `agent_id` uuids for
  // want of the roster. Nothing else is fetched.
  const listed = kindsToList(options.selector);

  for (const { type, path, kind } of KINDS) {
    if (!listed.has(kind)) continue;
    const { status, json } = await http("GET", `/api/${path}`);
    if (status !== 200) throw new Error(`fountain export: list ${path} returned ${status}`);
    const data = (json as { data?: Array<Record<string, unknown>> })?.data ?? [];

    const selected =
      !options.selector?.type ||
      options.selector.type === type ||
      options.selector.type === kind;

    for (const live of data) {
      const name = typeof live.name === "string" ? live.name : "";
      const agentId = typeof live.agent_id === "string" ? live.agent_id : "";

      if (kind === "Environment" && typeof live.id === "string") envNameById.set(live.id, name);
      if (kind === "Vault" && typeof live.id === "string") vaultNameById.set(live.id, name);
      if (kind === "Agent" && typeof live.id === "string") {
        agentNameById.set(live.id, name);
        agentOwned.set(live.id, isChantOwned(live));
      }
      if (kind === "Teammate" && agentId && name) teammateByAgentId.set(agentId, name);

      if (!selected) continue;

      // The logical id a generated `const` is named after, and what
      // `--name` matches.
      let logicalId = name;
      if (kind === "Webhook") {
        logicalId = typeof live.url === "string" ? webhookLogicalId(live.url) : "";
      } else if (kind === "Schedule") {
        const teammate = teammateByAgentId.get(agentId) ?? agentNameById.get(agentId) ?? "";
        logicalId = [teammate, name || "schedule"].filter(Boolean).join("-");
      }
      if (!logicalId) continue;
      if (options.selector?.name && options.selector.name !== logicalId) continue;

      // A teammate and a schedule inherit ownership from the agent behind them;
      // a webhook carries no marker at all, so `--owned` cannot claim it.
      if (options.owned) {
        if (kind === "Webhook") continue;
        const owner =
          kind === "Teammate" || kind === "Schedule"
            ? agentOwned.get(agentId) ?? false
            : isChantOwned(live);
        if (!owner) continue;
      }

      const readOnly = READ_ONLY[kind];
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(live)) {
        if (!options.verbatim && SERVER_FIELDS.includes(key)) continue;
        if (!options.verbatim && readOnly?.has(key)) continue;
        if (value === null || value === undefined) continue;
        properties[key] = value;
      }

      if (kind === "Environment") {
        // Secrets are write-only and not expressible on the typed surface.
        const { status: sStatus, json: sJson } = await http("GET", `/api/${path}/${live.id}/secrets`);
        const secretCount = sStatus === 200 ? (((sJson as { data?: unknown[] })?.data ?? []).length) : 0;
        if (secretCount > 0) {
          warn(
            `environment "${name}" carries ${secretCount} secret(s) — values are write-only and ` +
              `keys are not part of the typed surface; re-declare them via your secret provider`,
          );
        }
      }

      if (kind === "Agent") {
        rename(properties, "environment_id", "environment", envNameById);
      }

      if (kind === "Teammate") {
        // The roster row carries the agent whole and the launch settings on the
        // conversation; the authored shape is four names.
        const embedded = isRecord(live.agent) ? live.agent : undefined;
        const conversation = isRecord(live.conversation) ? live.conversation : {};
        if (typeof embedded?.name === "string") properties.agent = embedded.name;
        else if (agentId) {
          properties.agent_id = agentId;
          rename(properties, "agent_id", "agent", agentNameById);
        }
        for (const [idField, prop, names] of [
          ["environment_id", "environment", envNameById],
          ["vault_id", "vault", vaultNameById],
        ] as const) {
          const id = live[idField] ?? conversation[idField];
          if (typeof id !== "string") continue;
          properties[idField] = id;
          rename(properties, idField, prop, names);
        }
      }

      if (kind === "Schedule") {
        const teammate = teammateByAgentId.get(agentId);
        if (teammate) properties.teammate = teammate;
      }

      resources.push({ logicalId, type, properties });
    }
  }

  return { resources, parameters: [] } as ExportedTemplate;
}

/**
 * What each kind's references resolve through. A selected kind pulls in its
 * sources transitively, so `--type Schedule` still reads the roster it needs to
 * name a teammate, and `--type Environment` reads one endpoint.
 */
const REFERENCE_SOURCES: Record<string, readonly string[]> = {
  Environment: [],
  Vault: [],
  Agent: ["Environment"],
  Teammate: ["Agent", "Environment", "Vault"],
  Schedule: ["Teammate"],
  Webhook: [],
};

export function kindsToList(selector?: ResourceSelector): Set<string> {
  const wanted = KINDS.filter(
    (k) => !selector?.type || selector.type === k.type || selector.type === k.kind,
  ).map((k) => k.kind);

  const listed = new Set<string>();
  const add = (kind: string): void => {
    if (listed.has(kind)) return;
    listed.add(kind);
    for (const source of REFERENCE_SOURCES[kind] ?? []) add(source);
  };
  for (const kind of wanted) add(kind);
  return listed;
}

/** Swap an id field for the name of what it points at, when the name is known. */
function rename(
  properties: Record<string, unknown>,
  idField: string,
  prop: string,
  names: Map<string, string>,
): void {
  const id = properties[idField];
  if (typeof id !== "string") return;
  const name = names.get(id);
  if (!name) return;
  delete properties[idField];
  properties[prop] = name;
}
