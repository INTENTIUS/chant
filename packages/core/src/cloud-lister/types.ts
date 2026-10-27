/**
 * behold#1029: the cloud lister's output, the "listing result" source shape
 * of behold#1025's design (https://github.com/INTENTIUS/behold/issues/1025#issuecomment-6430966093,
 * ruled in #issuecomment-6431259469).
 *
 * The ruling puts the index schema's TypeScript types in chant core (Q5), and
 * chant's `typeListing` (../lifecycle/type-listing.ts, chant#4521) turns a
 * `ListingResult` into an `IndexDocument`. type-listing.ts reads the shape
 * loosely (an optional id and facts, any source name); this module is the
 * lister's exact output, and ../lifecycle/cloud-index.ts hands one to the
 * other, so the type checker holds them together.
 *
 * What the lister fills, per the design and chant#4520's ruled `EngineFacts`:
 *
 *  - every resource gets the path-style id the ruling names (Q2),
 *    `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>` (packages/core/src/cloud-lister/ids.ts);
 *  - `facts` carries only what a cloud listing can read: `markers` (from tags
 *    and labels), `cloudIds` and `observedAt`. `ownership`, `ownedBy` and
 *    `recordVersions` stay absent, because they are relative to an estate or
 *    stack and a record the lister never reads;
 *  - properties, tags and every string under them are masked before the
 *    result exists (packages/core/src/cloud-lister/mask.ts).
 */

import type { UnobservedReason } from "../observation";

/** The four substrates the lister reads, one per run (ruling Q6). */
export type Substrate = "aws" | "azure" | "gcp" | "kubernetes";

/** A tag or label filter: every pair must match. */
export type TagFilter = Readonly<Record<string, string>>;

/**
 * One run's scope (ruling Q6): one substrate and one account, subscription,
 * project or cluster, with every location and type the flags name. `"*"`
 * means every location or every type the inventory API returns.
 */
export interface CloudScope {
  substrate: Substrate;
  /** AWS account id, Azure subscription id, GCP project id, or a cluster name. */
  scopeId: string;
  /** Regions or locations (Kubernetes: namespaces), sorted and deduplicated, or `"*"`. */
  locations: readonly string[] | "*";
  /** Types as the inventory API names them, sorted and deduplicated, or `"*"`. */
  types: readonly string[] | "*";
  tagFilter?: TagFilter;
}

/**
 * What was looked at, per type and location (#1025 "Coverage"). A
 * (type, location) with no entry is not observed. `"*"` in `listedType` or
 * `location` means "every": a reader that does not know the wildcard compares
 * it as a literal, matches nothing, and so reads the entity as not observed,
 * which is the safe direction.
 */
export interface CoverageEntry {
  listedType: string;
  location: string;
  verdict: "listed" | UnobservedReason;
  detail?: string;
}

/** Why something was not listed, said once (#1029: "a type it cannot list goes in the notes"). */
export interface IndexNote {
  code:
    | "no-lister"        // the inventory API cannot list this type
    | "needs-parent"     // the type lists only under a parent identifier
    | "api-disabled"     // GCP: Cloud Asset API is off on the project; nothing was enabled
    | "read-failed"      // a call failed after retries
    | "no-credentials"   // the call was refused for its credentials
    | "default-types"    // AWS with types "*": a fixed default set was listed
    | "tag-filter";      // a tag filter narrows every entry to `filtered`
  message: string;
  listedType?: string;
  location?: string;
  /** A command the person can run themselves (never run by the lister). */
  command?: string;
}

/**
 * A cloud id, kinds as chant#4520 ruled them (`EngineFacts.cloudIds`):
 * `arn` for an ARN, `import-id` for Cloud Control's identifier (what
 * `declaredIdentifier` builds and an import takes), `provider-id` for an ARM
 * id (as returned and once lowercased, since Resource Graph lowercases) or a
 * GCP asset name, `self-link` for a GCP selfLink, `k8s-uid` for a
 * Kubernetes UID.
 */
export interface CloudId {
  kind: "import-id" | "arn" | "provider-id" | "self-link" | "k8s-uid";
  value: string;
}

/** chant#4520's `EngineFacts.markers`, as read off the live object's tags or labels. */
export interface MarkerFact {
  owner?: string;
  address?: string;
  encoding: "plain" | "escaped" | "digest";
  source: "live";
}

/** The facts a cloud listing can supply (ruling Q1: one nested object). */
export interface ListedFacts {
  markers?: MarkerFact;
  cloudIds: CloudId[];
  observedAt: string;
}

/** One listed object (#1025 `ListedResource`, plus the ruled id and facts). */
export interface ListedResource {
  /** `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>` (ruling Q2). */
  id: string;
  listedType: string;
  location: string;
  /** Cloud Control `Identifier`, the ARM id, the asset `name`, `namespace/name` or `name` for Kubernetes. */
  nativeId: string;
  cloudIds: CloudId[];
  tags: Record<string, string>;
  /** As returned, unnormalized, already masked. */
  properties: Record<string, unknown>;
  /** When the call that returned it answered. */
  observedAt: string;
  facts: ListedFacts;
}

/** The lister's whole output for one run (#1025 `ListingResult`). */
export interface ListingResult {
  listing: "v1";
  source: { name: "chant-lister"; version: string };
  scope: CloudScope;
  startedAt: string;
  completedAt: string;
  resources: ListedResource[];
  coverage: CoverageEntry[];
  notes: IndexNote[];
}
