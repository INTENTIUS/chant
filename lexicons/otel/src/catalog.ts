/**
 * The built-in entity catalog: every class this package exports, keyed by
 * class name. It feeds the packaged registry (`dist/meta.json`), LSP
 * completions and hover, and the docs.
 */

import type { LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { componentEntityType, type ComponentClass } from "./define";
import * as components from "./components";
import { PIPELINE_TYPE, SERVICE_TYPE } from "./pipeline";

export interface CatalogEntry {
  className: string;
  entityType: string;
  kind: "receiver" | "processor" | "exporter" | "extension" | "pipeline" | "service";
  /** The collector type, for components. */
  type?: string;
  description: string;
}

function isComponentClass(v: unknown): v is ComponentClass {
  return typeof v === "function" && typeof (v as { definition?: unknown }).definition === "object";
}

export const BUILTIN_CATALOG: CatalogEntry[] = [
  ...(Object.entries(components) as Array<[string, unknown]>)
    .filter((e): e is [string, ComponentClass] => isComponentClass(e[1]))
    .map(([className, cls]) => ({
      className,
      entityType: componentEntityType(cls.definition.kind, cls.definition.type),
      kind: cls.definition.kind,
      type: cls.definition.type,
      description: cls.definition.description ?? "",
    })),
  {
    className: "Pipeline",
    entityType: PIPELINE_TYPE,
    kind: "pipeline",
    description: "One pipeline under service.pipelines: receivers, then processors, then exporters, for one signal",
  },
  {
    className: "Service",
    entityType: SERVICE_TYPE,
    kind: "service",
    description: "service.extensions and service.telemetry",
  },
];

/** The catalog as a chant lexicon registry, keyed by class name. */
export function lexiconRegistry(): Record<string, LexiconEntry> {
  const out: Record<string, LexiconEntry> = {};
  for (const e of [...BUILTIN_CATALOG].sort((a, b) => a.className.localeCompare(b.className))) {
    out[e.className] = { resourceType: e.entityType, kind: "resource", lexicon: "otel" };
  }
  return out;
}
