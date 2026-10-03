/**
 * Where a workload keeps its pod spec, and the release attributes a deploy
 * writes onto it (#3059, #3061, ws-081).
 *
 * The build stamps each container of a workload with `OTEL_SERVICE_NAME` and
 * `OTEL_RESOURCE_ATTRIBUTES` (the serializer), and with
 * `CHANT_RELEASE_ATTRIBUTES` read through the downward API from the pod
 * annotation `chant.intentius.io/release-attributes`, which
 * `OTEL_RESOURCE_ATTRIBUTES` ends with as `$(CHANT_RELEASE_ATTRIBUTES)`. An
 * absent annotation reads as empty, so the built manifest works as it is. A
 * release deploy (`kubectl-apply` with a release on its context) sets the
 * annotation on the pod template of each stamped workload in what it applies,
 * leaving the committed manifest the same bytes.
 *
 * Kept free of the API client and the serializer so the capability module can
 * import it without loading either.
 */
import { RELEASE_ATTRIBUTES_ANNOTATION, RELEASE_ATTRIBUTES_VARIABLE } from "@intentius/chant/telemetry-attribution";

/** Where each workload kind keeps its pod spec. */
export const POD_SPEC_PATHS: Record<string, readonly string[]> = {
  Pod: ["spec"],
  Deployment: ["spec", "template", "spec"],
  StatefulSet: ["spec", "template", "spec"],
  DaemonSet: ["spec", "template", "spec"],
  ReplicaSet: ["spec", "template", "spec"],
  Job: ["spec", "template", "spec"],
  CronJob: ["spec", "jobTemplate", "spec", "template", "spec"],
};

/** The core API groups those kinds live in; a CRD that reuses a kind name is not a workload. */
const WORKLOAD_API_VERSIONS = new Set(["v1", "apps/v1", "batch/v1"]);

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, path: readonly string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** A workload's pod spec, or undefined for anything else. */
export function podSpecOf(manifest: Obj): Obj | undefined {
  const path = POD_SPEC_PATHS[manifest.kind as string];
  if (!path || !WORKLOAD_API_VERSIONS.has(manifest.apiVersion as string)) return undefined;
  const spec = at(manifest, path);
  return isObj(spec) ? spec : undefined;
}

/** The env entry that reads the release attributes from the pod annotation. */
export function releaseAttributesEnv(): Obj {
  return {
    name: RELEASE_ATTRIBUTES_VARIABLE,
    valueFrom: { fieldRef: { fieldPath: `metadata.annotations['${RELEASE_ATTRIBUTES_ANNOTATION}']` } },
  };
}

/** True when some container of the workload reads the release attributes, i.e. the build stamped it. */
function readsRelease(podSpec: Obj): boolean {
  const containers = podSpec.containers;
  if (!Array.isArray(containers)) return false;
  return containers.some(
    (c) => isObj(c) && Array.isArray(c.env) && c.env.some((e) => isObj(e) && e.name === RELEASE_ATTRIBUTES_VARIABLE && isObj(e.valueFrom)),
  );
}

/**
 * Set the release-attributes annotation on the pod template (or the Pod) of
 * every stamped workload in `documents`, in place, and return how many it
 * set. A workload the build did not stamp is left alone.
 */
export function annotateRelease(documents: Obj[], suffix: string): number {
  let count = 0;
  for (const doc of documents) {
    const podSpec = podSpecOf(doc);
    if (!podSpec || !readsRelease(podSpec)) continue;
    const path = POD_SPEC_PATHS[doc.kind as string]!;
    const owner = path.length === 1 ? doc : at(doc, path.slice(0, -1));
    if (!isObj(owner)) continue;
    const metadata = isObj(owner.metadata) ? owner.metadata : {};
    const annotations = isObj(metadata.annotations) ? metadata.annotations : {};
    owner.metadata = { ...metadata, annotations: { ...annotations, [RELEASE_ATTRIBUTES_ANNOTATION]: suffix } };
    count++;
  }
  return count;
}
