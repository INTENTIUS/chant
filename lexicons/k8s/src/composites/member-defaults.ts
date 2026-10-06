/**
 * Types for the per-member `defaults` option on composites.
 *
 * Each member's override is checked against the constructor props of the
 * generated class that builds it. The override is merged into the composite's
 * own props by mergeDefaults, so objects are partial at every depth; arrays
 * are appended, so their elements stay complete.
 *
 * The props come from the generated declaration file. `../generated` itself
 * resolves to the runtime index.ts, whose classes take `Record<string, unknown>`.
 * The lexicon build copies that declaration file next to the emitted types so
 * the reference resolves for consumers too.
 */

import type * as Generated from "../generated/index.d";

/** Objects become optional at every depth; arrays and scalars are kept as-is. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Override type for one member, named by its generated class (e.g. "StatefulSet"). */
export type MemberDefaults<K extends keyof typeof Generated> = (typeof Generated)[K] extends abstract new (
  props: infer P,
) => unknown
  ? DeepPartial<P>
  : never;
