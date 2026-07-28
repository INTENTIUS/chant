/**
 * Test doubles for `chant kube` (chant #1079).
 *
 * `./project.ts`'s real `loadKubeProjectContext` builds an actual project
 * (`chant.config.ts` read, source discovered, serialized) — every verb takes
 * it as an injectable dependency for exactly this reason: a unit test builds
 * a `KubeProjectContext` by hand instead, the same way `../api/fake-cluster.ts`
 * lets a test build a client without a socket.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { setProvenance, type EntityProvenance } from "@intentius/chant/provenance";
import type { ChantConfig } from "@intentius/chant/config";
import type { KubeProjectContext } from "./project";

export type FakeDeclarable = Declarable & { props: Record<string, unknown> };

/** A minimal `Declarable` carrying `props`, optionally stamped with build provenance. */
export function fakeDeclarable(
  entityType: string,
  props: Record<string, unknown>,
  provenance?: EntityProvenance,
): FakeDeclarable {
  const entity: FakeDeclarable = {
    lexicon: "k8s",
    entityType,
    kind: "resource",
    props,
    [DECLARABLE_MARKER]: true,
  };
  if (provenance) setProvenance(entity, provenance);
  return entity;
}

/** A `KubeProjectContext` built from a plain name → entity map, no disk I/O. */
export function fakeProjectContext(
  entities: Record<string, Declarable>,
  config: ChantConfig = {},
  cwd = "/project",
): KubeProjectContext {
  return { cwd, config, entities: new Map(Object.entries(entities)) };
}
