/**
 * Live export — read fountain resources back as import IR for
 * `chant import --from`. The adoption path: an org with UI-built
 * environments/vaults/agents gets typed leaf files.
 *
 * Server-written fields are stripped to the authored shape; an agent's
 * `environment_id` is resolved back to the exported environment's logical
 * name so the generated code carries a reviewable reference. Secret
 * *values* never leave fountain (write-only upstream) and secret *keys*
 * cannot round-trip into typed code yet — the request schema has no
 * secrets field (they are a sub-resource; fountain#148's reference model
 * would change this) — so environments export without their secrets and
 * the caller is warned per environment that carries any.
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

  for (const { type, path, kind } of KINDS) {
    if (options.selector?.type && options.selector.type !== type && options.selector.type !== kind) continue;

    const { status, json } = await http("GET", `/api/${path}`);
    if (status !== 200) throw new Error(`fountain export: list ${path} returned ${status}`);
    const data = ((json as { data?: Array<Record<string, unknown>> })?.data ?? []);

    for (const live of data) {
      const name = typeof live.name === "string" ? live.name : "";
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
        envNameById.set(String(live.id), name);
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

      if (kind === "Agent" && typeof properties.environment_id === "string") {
        const envName = envNameById.get(properties.environment_id);
        if (envName) {
          delete properties.environment_id;
          properties.environment = envName;
        }
      }

      resources.push({ logicalId: name, type, properties });
    }
  }

  return { resources, parameters: [] } as ExportedTemplate;
}
