/**
 * The gcp lexicon's identity rule for indexed resources (#4538, on #4523's
 * matcher, ../../../packages/core/src/lifecycle/identity-match.ts).
 *
 * core's GCP lister (packages/core/src/cloud-lister/gcp.ts) lists one project
 * through Cloud Asset `searchAllResources` and writes each asset as:
 *
 * - `listedType` its asset type (`compute.googleapis.com/Instance`);
 * - `location` the asset's location, lowercased, or `global` when it has none;
 * - `nativeId` the Cloud Asset resource name
 *   (`//compute.googleapis.com/projects/p/zones/us-central1-a/instances/vm`);
 * - cloud ids: that name as `provider-id`, and the `selfLink` as `self-link`
 *   when the summary carries one.
 *
 * A Config Connector declaration spells the resource's name (`resourceID`,
 * else `metadata.name`) and, for a regional or zonal kind, its `location`,
 * `region` or `zone`. It does not spell the rest of the resource name: the
 * project is the index's own scope, and a bucket's name reads
 * `projects/_/buckets/<name>` on GCP and `<name>` on floci-gcp. So a node's
 * key is the last segment of its resource name, and a declaration matches the
 * node of its asset type whose key is its name, at its location.
 *
 * A declaration whose location is a literal is looked for there. One with no
 * location field, or one spelled with a reference, is looked for at every
 * location: a global kind (a network, a topic) and a kind whose location the
 * declaration leaves to a reference both match by name across the project,
 * and two nodes of one name are refused, never guessed between.
 *
 * What cannot match:
 * - a name the declaration leaves out or spells with a reference: `no-binding`;
 * - a kind Cloud Asset names by a number the service assigns (a service
 *   account by its unique id, a project or folder by its number): `no-binding`;
 * - a kind with no asset type: `unsupported-kind`.
 *
 * Identity edges (#4523/#4535): GCP spells one reference several ways. An
 * asset name (`//pubsub.googleapis.com/projects/p/topics/t`), the relative
 * name most APIs write (`projects/p/topics/t`), and for Compute the selfLink
 * (`https://www.googleapis.com/compute/v1/projects/p/global/networks/n`). A
 * node answers to all three, so an edge is drawn whichever one a property
 * holds.
 */
import type { DeclaredIdentity, IndexIdentity } from "@intentius/chant/lifecycle/identity-match";
import { ANY_LOCATION } from "@intentius/chant/lifecycle/identity-match";
import type { NodeIdentityValue } from "@intentius/chant/graph-refs";
import type { IRNode } from "@intentius/chant/graph-ir";
import { gcpListedTypeForKind } from "./listed-types";

/** Asset types whose resource name ends in a number the service assigns, not a name a declaration spells. */
const SERVER_NAMED_ASSET_TYPES: Readonly<Record<string, string>> = {
  "iam.googleapis.com/ServiceAccount": "a service account by its unique id",
  "cloudresourcemanager.googleapis.com/Project": "a project by its number",
  "cloudresourcemanager.googleapis.com/Folder": "a folder by its number",
  "cloudresourcemanager.googleapis.com/Organization": "an organization by its number",
};

/** The Config Connector fields that hold a resource's location, in the order read. */
const LOCATION_FIELDS = ["zone", "region", "location"] as const;

/** Compute's REST base: a Compute selfLink is this plus the relative name. */
const COMPUTE_SELF_LINK_BASE = "https://www.googleapis.com/compute/v1/";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

/** A declared field, read at the top level (a declarable's props) or under `spec` (a manifest). */
function field(props: Record<string, unknown>, name: string): unknown {
  if (props[name] !== undefined) return props[name];
  return isRecord(props.spec) ? props.spec[name] : undefined;
}

/** The name Config Connector gives the resource: `resourceID`, else `metadata.name`. */
function declaredName(props: Record<string, unknown>): unknown {
  const id = field(props, "resourceID");
  if (id !== undefined) return id;
  return isRecord(props.metadata) ? props.metadata.name : undefined;
}

/** The last segment of a resource name: the name a declaration spells. */
export function gcpNodeKey(node: Pick<IRNode, "nativeId">): string | undefined {
  const id = node.nativeId;
  if (!id) return undefined;
  const last = id.slice(id.lastIndexOf("/") + 1);
  return last === "" ? undefined : last;
}

/**
 * The identifier a gcp declaration spells for the index, or why it spells
 * none. `listedTypeFor` maps a kind to its asset type; a test passes one.
 */
export function gcpDeclaredIdentity(
  entityType: string,
  props: Record<string, unknown>,
  listedTypeFor: (kind: string) => string | undefined = gcpListedTypeForKind,
): DeclaredIdentity {
  const listedType = listedTypeFor(entityType);
  if (!listedType) {
    return { kind: "unmatchable", reason: "unsupported-kind", detail: `${entityType} has no Cloud Asset type on record` };
  }
  const serverNamed = SERVER_NAMED_ASSET_TYPES[listedType];
  if (serverNamed) {
    return {
      kind: "unmatchable",
      reason: "no-binding",
      detail: `Cloud Asset names ${serverNamed}, which the service assigns, so no ${entityType} declaration states it`,
    };
  }
  const name = declaredName(props);
  if (!nonEmptyString(name)) {
    return { kind: "unmatchable", reason: "no-binding", detail: `identity is not in the declaration (${entityType} resourceID or metadata.name)` };
  }
  let location: string = ANY_LOCATION;
  for (const f of LOCATION_FIELDS) {
    const v = field(props, f);
    if (nonEmptyString(v)) {
      location = v.toLowerCase();
      break;
    }
  }
  return { kind: "identifier", listedType, identifier: name, global: false, location };
}

/** The relative resource name (`projects/p/topics/t`) of an asset name (`//pubsub.googleapis.com/projects/p/topics/t`). */
export function relativeResourceName(assetName: string): string | undefined {
  const m = /^\/\/[^/]+\/(.+)$/.exec(assetName);
  return m ? m[1] : undefined;
}

/** The values that name an indexed gcp asset: its asset name, its relative name, and its selfLink. */
export function gcpNodeIdentities(node: IRNode): NodeIdentityValue[] {
  const out: NodeIdentityValue[] = [];
  const seen = new Set<string>();
  const push = (kind: string, value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ kind, value });
  };
  push("native-id", node.nativeId);
  for (const c of node.facts?.cloudIds ?? []) if (c.kind === "provider-id" || c.kind === "self-link") push(c.kind, c.value);
  const relative = node.nativeId ? relativeResourceName(node.nativeId) : undefined;
  push("relative-name", relative);
  if (relative && node.nativeId!.startsWith("//compute.googleapis.com/")) push("self-link", COMPUTE_SELF_LINK_BASE + relative);
  return out;
}

export function createGcpIndexIdentity(listedTypeFor?: (kind: string) => string | undefined): IndexIdentity {
  return {
    substrate: "gcp",
    declaredIdentity: (entityType, props) => gcpDeclaredIdentity(entityType, props, listedTypeFor),
    nodeIdentities: gcpNodeIdentities,
    nodeKey: gcpNodeKey,
  };
}

export const gcpIndexIdentity: IndexIdentity = createGcpIndexIdentity();
