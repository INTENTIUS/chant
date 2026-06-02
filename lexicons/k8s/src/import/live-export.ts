import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { K8sParser } from "./parser";

/**
 * Server-managed metadata fields that the API server fills in. They are not
 * part of the declared shape and would only add noise to regenerated source,
 * so they are stripped unless `verbatim` is set.
 */
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

/** Annotations the cluster writes back that are not authored config. */
const SERVER_ANNOTATIONS = [
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip `status`, `managedFields`, and other server-written fields to reach the
 * declared shape. Returns a new object; the input is not mutated.
 */
export function stripServerFields(obj: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  delete clone.status;

  if (isRecord(clone.metadata)) {
    const md = clone.metadata;
    for (const f of SERVER_METADATA_FIELDS) delete md[f];
    if (isRecord(md.annotations)) {
      for (const a of SERVER_ANNOTATIONS) delete md.annotations[a];
      if (Object.keys(md.annotations).length === 0) delete md.annotations;
    }
  }
  return clone;
}

/**
 * Build full-fidelity export IR from a list of live Kubernetes objects (the
 * `items` of a `kubectl get -o json` List). Reuses the import K8sParser by
 * feeding it the cleaned objects as JSON documents — JSON is valid YAML, so no
 * separate serializer is needed. Pure: all I/O stays in the caller.
 */
export function buildExportFromObjects(
  objects: unknown[],
  opts: { verbatim?: boolean; selector?: ResourceSelector } = {},
): ExportedTemplate {
  const cleaned = objects
    .filter(isRecord)
    .map((o) => (opts.verbatim ? o : stripServerFields(o)));

  const content = cleaned.map((o) => JSON.stringify(o, null, 2)).join("\n---\n");
  const ir = new K8sParser().parse(content);

  const selector = opts.selector;
  if (!selector || (selector.type === undefined && selector.name === undefined)) {
    return ir;
  }
  return {
    ...ir,
    resources: ir.resources.filter((r) => {
      const liveName = (r.metadata?.originalName as string | undefined) ?? r.logicalId;
      return (
        (selector.type === undefined || r.type === selector.type) &&
        (selector.name === undefined || liveName === selector.name)
      );
    }),
  };
}
