/**
 * The object-store errors and write conditions, apart from the clients
 * (chant#4589): `@intentius/chant/object-store/errors`. This module imports
 * nothing, so code bound for an edge runtime (the terraform lexicon's
 * registry/edge, a Cloudflare Worker without nodejs_compat) can name a store
 * conflict without pulling the S3, GCS and Azure clients and their Node
 * built-ins into its bundle. ./common.ts re-exports all of it, so the class a
 * client throws is the class a caller of either path catches.
 */

export class StoreError extends Error {}

/** A conditional write that lost: the object changed (412) or another write to it was in flight (409). */
export class StoreConflict extends StoreError {}

/** A condition on a write: the version the object must still have (an ETag, a generation), or `*` for "there is no object yet". */
export type StoreCondition = { ifMatch: string } | { ifNoneMatch: "*" };

/**
 * Whether `e` is a lost conditional write: chant's `StoreConflict`, or any
 * error named `StoreConflict` (a caller's own store, or a copy of chant
 * loaded twice). The class check comes first, since a minified bundle
 * renames constructors.
 */
export const isStoreConflict = (e: unknown): boolean =>
  e instanceof StoreConflict || (e instanceof Error && (e.name === "StoreConflict" || e.constructor.name === "StoreConflict"));
