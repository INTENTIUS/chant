/**
 * The `decide` block in `chant.config.ts`: the backends a decision point's
 * model decider names, which the `decide` Op activity calls (#2828).
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 *
 * export default {
 *   decide: {
 *     backends: {
 *       systemone: { url: "https://api.typesafe.ai", key: { env: "TYPESAFE_API_KEY" } },
 *       local: { url: "http://127.0.0.1:8080" },
 *       studio: { url: "http://127.0.0.1:7071", key: { capability: "inference", member: "box" } },
 *     },
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * A point's model decider says `"backend": "systemone"`, and that name is the
 * key here. A backend is an endpoint that speaks the `POST /v1/systemone` wire
 * format (TypeSafe's, or any server that implements it, #2491) and where its
 * key comes from.
 *
 * The key is never a literal. It is either an environment variable's name, or
 * a capability the workspace declares as brokered on a box member (#2726).
 * With a brokered capability the broker holds the credential: it either sets
 * the variable `env` names for this process, or it is itself the endpoint and
 * adds the key on the way through, in which case no key is sent from here.
 * SYS001 refuses a string literal where a key goes.
 *
 * This module holds only the schemas, so `../config.ts` can validate the
 * block without loading the client or anything under `workspace/`.
 */

import { z } from "zod";

/** A key read from an environment variable at call time. */
export const envKeySchema = z.strictObject({
  /** The variable's name. */
  env: z.string().min(1),
});

/**
 * A key reached through a capability a box member declares as brokered
 * (`box.capabilities` in `chant.workspace.json`, #2726). The capability must be
 * declared and name a broker, or the call is refused.
 */
export const brokeredKeySchema = z.strictObject({
  /** The capability's name in the box block, such as `inference`. */
  capability: z.string().min(1),
  /** The member whose box declares it. Without it, the one member that declares the capability. */
  member: z.string().min(1).optional(),
  /**
   * The environment variable the broker sets with the scoped key. Without it,
   * the broker is the endpoint and adds the key itself, so none is sent.
   */
  env: z.string().min(1).optional(),
});

export const keySchema = z.union([envKeySchema, brokeredKeySchema]);

export const backendSchema = z.strictObject({
  /** The server's base URL. `/v1/systemone` is appended. */
  url: z.string().min(1),
  /** Where the bearer key comes from. Omitted for a server that takes none, such as a local one. */
  key: keySchema.optional(),
  /** How long to wait for an answer before the backend counts as unreachable, in milliseconds. Default 30000. */
  timeoutMs: z.number().int().positive().optional(),
});

export const decideConfigSchema = z.strictObject({
  /** Backend name, as a point's model decider names it, to the backend. */
  backends: z.record(z.string(), backendSchema).optional(),
});

export type EnvKey = z.infer<typeof envKeySchema>;
export type BrokeredKey = z.infer<typeof brokeredKeySchema>;
export type BackendKey = z.infer<typeof keySchema>;
export type DecideBackend = z.infer<typeof backendSchema>;
export type DecideConfig = z.infer<typeof decideConfigSchema>;
