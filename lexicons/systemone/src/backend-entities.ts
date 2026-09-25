/**
 * The configured backends as build entities.
 *
 * The lexicon declares no resources, and the one thing a project does declare
 * for it is `systemone.backends`. The `buildRoots()` hook turns each backend
 * into an entity, the way the terraform lexicon turns each of
 * `terraform.roots`, so the post-synth checks can read the backends a build
 * carries (SYS010 reads their URLs and keys) and `chant build` has this
 * lexicon's output to file. An entity carries the backend's URL and where its
 * key comes from (a variable's name or a capability), never a key: the
 * config holds none.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { SystemoneBackend, SystemoneConfig } from "./config";

export const BACKEND_TYPE = "Systemone::Backend";

export interface BackendEntity extends Declarable {
  readonly props: { name: string; url: string; key?: SystemoneBackend["key"]; timeoutMs?: number };
}

export function backendEntity(name: string, backend: SystemoneBackend): BackendEntity {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "systemone",
    entityType: BACKEND_TYPE,
    kind: "resource",
    props: {
      name,
      url: backend.url,
      ...(backend.key !== undefined ? { key: backend.key } : {}),
      ...(backend.timeoutMs !== undefined ? { timeoutMs: backend.timeoutMs } : {}),
    },
  } as BackendEntity;
}

/** One entity per configured backend, keyed `backend/<name>`. */
export function backendEntities(config: Record<string, unknown>): Map<string, Declarable> {
  const backends = (config as { systemone?: SystemoneConfig }).systemone?.backends ?? {};
  return new Map(Object.entries(backends).map(([name, b]) => [`backend/${name}`, backendEntity(name, b)]));
}
