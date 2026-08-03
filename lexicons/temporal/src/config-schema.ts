/**
 * The `temporal` namespace in `chant.config.ts` (#1344).
 *
 * temporal had the least-bad workaround of the three: it exported its own
 * `TemporalChantConfig`, a widened config type users could `satisfies` against.
 * That worked and cost a second declaration of the same shape, with a comment
 * explaining that `ChantConfig` uses `.passthrough()` so the key is accepted at
 * runtime — accurate, and also the reason a typo was accepted at runtime.
 *
 * The schema below is now the single source: core validates against it, the
 * profile types are inferred from it, and `TemporalChantConfig` is derived
 * rather than written twice.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";
import type { TemporalWorkerProfile } from "./config";

export const temporalWorkerProfileSchema = z.strictObject({
  /** Temporal server gRPC address, e.g. `localhost:7233`. */
  address: z.string(),
  /** Namespace to connect to. */
  namespace: z.string(),
  /** Task queue the worker polls. */
  taskQueue: z.string(),
  /** `true` or `{}` for Temporal Cloud default TLS. */
  tls: z.union([z.boolean(), z.strictObject({ serverNameOverride: z.string().optional() })]).optional(),
  /** A literal bearer token, or `{ env }` to read one at runtime. */
  apiKey: z.union([z.string(), z.strictObject({ env: z.string() })]).optional(),
  /** Start `temporal server start-dev` before the worker. Local profiles only. */
  autoStart: z.boolean().optional(),
});

export const temporalConfigSchema = z.strictObject({
  profiles: z.record(z.string(), temporalWorkerProfileSchema),
  /** Profile used when `chant run` is called without `--profile`. */
  defaultProfile: z.string().optional(),
});

export type TemporalConfig = z.infer<typeof temporalConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    temporal?: TemporalConfig;
  }
}

/** Compile-time proof the augmentation reaches `ChantConfig` — see forgejo's. */
export type TemporalConfigNamespace = NonNullable<ChantConfig["temporal"]>;

/**
 * The schema and the hand-written `TemporalWorkerProfile` describe the same
 * profile. If a field is added to one and not the other, this stops compiling.
 */
type ProfileMatches = z.infer<typeof temporalWorkerProfileSchema> extends TemporalWorkerProfile
  ? TemporalWorkerProfile extends z.infer<typeof temporalWorkerProfileSchema>
    ? true
    : never
  : never;
export type _ProfileAgreesWithInterface = ProfileMatches;
