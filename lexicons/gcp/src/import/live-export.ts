import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { hasOwnershipMarker } from "@intentius/chant/ownership";
import { GcpParser } from "./parser";

/** Server-written metadata fields, stripped unless `verbatim`. */
const SERVER_METADATA_FIELDS = [
  "managedFields",
  "uid",
  "resourceVersion",
  "generation",
  "creationTimestamp",
  "selfLink",
  "ownerReferences",
  "finalizers",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip `status` and server-written metadata to reach the declared shape of a
 * Config Connector object. Config Connector writes back several
 * `cnrm.cloud.google.com/*` annotations that are not authored config; those are
 * dropped too. Returns a new object; the input is not mutated.
 */
export function stripServerFields(obj: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  delete clone.status;

  if (isRecord(clone.metadata)) {
    const md = clone.metadata;
    for (const f of SERVER_METADATA_FIELDS) delete md[f];
    if (isRecord(md.annotations)) {
      for (const key of Object.keys(md.annotations)) {
        // Config Connector's own bookkeeping annotations, plus the apply
        // round-trip annotation — none are authored config.
        if (
          key.startsWith("cnrm.cloud.google.com/") ||
          key === "kubectl.kubernetes.io/last-applied-configuration"
        ) {
          delete md.annotations[key];
        }
      }
      if (Object.keys(md.annotations).length === 0) delete md.annotations;
    }
  }
  return clone;
}

/**
 * Build full-fidelity export IR from a list of live Config Connector objects
 * (each live object is already its manifest). Reuses the import GcpParser by
 * feeding cleaned objects as JSON documents. Pure: all I/O stays in the caller.
 */
export function buildExportFromObjects(
  objects: unknown[],
  opts: { verbatim?: boolean; selector?: ResourceSelector; owned?: boolean } = {},
): ExportedTemplate {
  const owning = opts.owned
    ? objects.filter((o) => {
        if (!isRecord(o)) return false;
        const labels = isRecord(o.metadata) ? (o.metadata.labels as Record<string, unknown>) : undefined;
        return hasOwnershipMarker(labels, "label");
      })
    : objects;

  const cleaned = owning
    .filter(isRecord)
    .map((o) => (opts.verbatim ? o : stripServerFields(o)));

  const content = cleaned.map((o) => JSON.stringify(o, null, 2)).join("\n---\n");
  const ir = new GcpParser().parse(content);

  const selector = opts.selector;
  if (!selector || (selector.type === undefined && selector.name === undefined)) {
    return ir;
  }
  return {
    ...ir,
    resources: ir.resources.filter(
      (r) =>
        (selector.type === undefined || r.type === selector.type) &&
        (selector.name === undefined || r.logicalId === selector.name),
    ),
  };
}
