/**
 * Live export — read fountain resources back as import IR for
 * `chant import --from`. The adoption path: an org with UI-built
 * environments, vaults and agents gets typed leaf files.
 *
 * Server-written fields are stripped to the authored shape, and an agent's
 * server-resolved `environment_id` is put back into the vocabulary an author
 * writes, the environment's name. Secret *values* never leave fountain
 * (write-only upstream) and secret *keys* cannot round-trip into typed code
 * yet — the request schema has no secrets field (they are a sub-resource;
 * fountain#148's reference model would change this) — so environments export
 * without their secrets and the caller is warned per environment that carries
 * any.
 *
 * Teammates, schedules and webhooks were exported too until Managoat removed
 * them (managoat/managoat#2793).
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

const KINDS: Array<{ type: string; path: string; kind: string }> = [
  { type: "Fountain::V1::Environment", path: "environments", kind: "Environment" },
  { type: "Fountain::V1::Vault", path: "vaults", kind: "Vault" },
  { type: "Fountain::V1::Agent", path: "agents", kind: "Agent" },
];

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

  // A kind is listed when the selector wants it, and also when something the
  // selector wants resolves a reference through it: the id → name maps below
  // are what turn a server-resolved reference back into the name an author
  // writes, and exporting only agents must not produce `environment_id` uuids
  // for want of the environments. Nothing else is fetched.
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
      // The logical id a generated `const` is named after, and what
      // `--name` matches.
      const name = typeof live.name === "string" ? live.name : "";

      if (kind === "Environment" && typeof live.id === "string") envNameById.set(live.id, name);

      if (!selected) continue;
      if (!name) continue;
      if (options.selector?.name && options.selector.name !== name) continue;
      if (options.owned && !isChantOwned(live)) continue;

      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(live)) {
        if (!options.verbatim && SERVER_FIELDS.includes(key)) continue;
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

      resources.push({ logicalId: name, type, properties });
    }
  }

  return { resources, parameters: [] } as ExportedTemplate;
}

/**
 * What each kind's references resolve through. A selected kind pulls in its
 * sources transitively, so `--type Agent` still reads the environments it needs
 * to name one, and `--type Environment` reads one endpoint.
 */
const REFERENCE_SOURCES: Record<string, readonly string[]> = {
  Environment: [],
  Vault: [],
  Agent: ["Environment"],
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
