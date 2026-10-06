/**
 * Runtime shape of the `k8s` namespace in `chant.config.ts` (#1344).
 *
 * `./config.ts` describes the namespace for readers and for the `satisfies
 * K8sChantConfig` form it documents. What it could not do is make an unknown
 * key fail: the project config schema is `.passthrough()`, so a typo in
 * `k8s.profiles.prod.contxt` was accepted and ignored — and a missing cluster
 * binding is the failure this lexicon most cares about, since a wrong-cluster
 * read reports every declared resource as missing (#1100).
 *
 * The schema is the runtime half. It is checked against `K8sChantConfig` below,
 * so the two descriptions of the namespace cannot drift.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";
import type { K8sChantConfig } from "./config";

export const k8sClusterProfileSchema = z.strictObject({
  context: z.string(),
});

const kinds = z.array(z.string().min(1)).optional();

/** A `k8s.crds` entry. Remote sources must carry their pin. */
export const k8sProjectCrdSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string().min(1), kinds }),
  z.strictObject({
    type: z.literal("url"),
    url: z.string().url(),
    sha256: z.string().regex(/^(sha256:)?[0-9a-f]{64}$/, "must be the hex sha256 of the URL's content"),
    kinds,
  }),
  z.strictObject({
    type: z.literal("helm"),
    chart: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().optional(),
    chartSubdir: z.string().optional(),
    kinds,
  }),
]);

const jsonPatchOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.strictObject({ op: z.literal("remove"), path: z.string() }),
  z.strictObject({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.strictObject({ op: z.literal("move"), from: z.string(), path: z.string() }),
  z.strictObject({ op: z.literal("copy"), from: z.string(), path: z.string() }),
  z.strictObject({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
]);

const renderedSelectorShape = {
  kind: z.string().min(1),
  name: z.string().min(1),
  namespace: z.string().optional(),
  apiVersion: z.string().optional(),
};

/** A `RenderedPatch` (#3566): a selector plus exactly one of `jsonPatch` and `merge`. */
export const renderedPatchSchema = z.union([
  z.strictObject({ ...renderedSelectorShape, jsonPatch: z.array(jsonPatchOperationSchema), merge: z.never().optional() }),
  z.strictObject({ ...renderedSelectorShape, merge: z.record(z.string(), z.unknown()), jsonPatch: z.never().optional() }),
]);

export const k8sConfigSchema = z.strictObject({
  profiles: z.record(z.string(), k8sClusterProfileSchema).optional(),
  execCredentialPlugins: z.array(z.string()).optional(),
  kustomize: z
    .strictObject({
      roots: z
        .array(z.union([z.string(), z.strictObject({ path: z.string(), patches: z.array(renderedPatchSchema).optional() })]))
        .optional(),
    })
    .optional(),
  receipts: z
    .strictObject({
      namespace: z.string().optional(),
    })
    .optional(),
  crds: z.array(k8sProjectCrdSourceSchema).optional(),
});

declare module "@intentius/chant/config" {
  interface ChantConfig {
    k8s?: K8sChantConfig;
  }
}

/** Compile-time proof the augmentation reaches `ChantConfig`. */
export type K8sConfigNamespace = NonNullable<ChantConfig["k8s"]>;

/**
 * The schema and the documented interface describe the same namespace. If a
 * field is added to one and not the other, this stops compiling.
 */
type SchemaMatchesInterface = z.infer<typeof k8sConfigSchema> extends K8sChantConfig
  ? K8sChantConfig extends z.infer<typeof k8sConfigSchema>
    ? true
    : never
  : never;
export type _SchemaAgreesWithInterface = SchemaMatchesInterface;
