/**
 * k3d SimpleConfig YAML serializer.
 *
 * Emits the config file `k3d cluster create --config` consumes verbatim —
 * the walk-away artifact that justifies a lexicon here at all. One YAML
 * document per declared Cluster: the first is the primary output, any
 * further clusters land in files[] keyed `<name>.k3d.yaml`.
 *
 * Three things are non-negotiable in the output (#1408):
 *
 *   - `apiVersion` and `kind` are literal schema properties, not derived
 *     from a type name. They default when undeclared and are never dropped.
 *   - Booleans stay booleans and zero stays zero. `agents: 0` is the normal
 *     local shape and `updateDefaultKubeconfig: "false"` is truthy.
 *   - `nodeFilters` pass through untouched — they are k3d's own syntax
 *     (`server:0`, `agent:*`, `loadbalancer`) and rewriting them here would
 *     be inventing a dialect.
 *
 * ## The kubeconfig default is chant's, not upstream's
 *
 * When a declaration says nothing about `options.kubeconfig`, the emitted
 * config pins `updateDefaultKubeconfig: false` and `switchCurrentContext:
 * false` — the opposite of k3d's own defaults, chosen deliberately (#1411):
 * a tool that reconciles infrastructure must not rewrite ~/.kube/config or
 * repoint the caller's shell as a side effect. Injecting the values into the
 * artifact rather than relying on activity flags means the emitted YAML says
 * on its face what creating the cluster will do, and `k3d --config` applied
 * by hand behaves identically. A declaration that sets `options.kubeconfig`
 * itself — either key — is passed through exactly as written; upstream
 * defaults then apply to whatever it left unset, because a partially
 * explicit block is the author taking the wheel.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult, SerializeContext } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitYAML } from "@intentius/chant/yaml";
import { ownershipEntries, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";

const CLUSTER_TYPE = "K3d::Cluster";
const API_VERSION = "k3d.io/v1alpha5";
const KIND = "Simple";

/**
 * Top-level key order, matching the schema's own property order so a chant
 * emission diffs cleanly against upstream's documented examples.
 */
const KEY_ORDER = [
  "apiVersion",
  "kind",
  "metadata",
  "servers",
  "agents",
  "kubeAPI",
  "image",
  "network",
  "subnet",
  "token",
  "volumes",
  "ports",
  "files",
  "env",
  "registries",
  "hostAliases",
  "options",
];

const visitor: SerializerVisitor = {
  attrRef: (name) => name,
  resourceRef: (name) => name,
  propertyDeclarable: (entity, walk) => {
    if (!isResourceDeclarable(entity) || typeof entity.props !== "object" || entity.props === null) {
      return undefined;
    }
    const props = entity.props as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined) result[key] = walk(value);
    }
    return result;
  },
};

/**
 * Stamp the ownership marker as Docker labels on every node, via
 * `options.runtime.labels` (#1412). The labels survive `k3d cluster stop`/
 * `start` and are readable back through `docker inspect` — verified live;
 * `k3d cluster list -o json` does not expose custom labels, so the read
 * side goes to Docker. An author's own label with the same key wins.
 */
function stampOwnership(
  options: Record<string, unknown>,
  ownership: NonNullable<SerializeContext["ownership"]>,
): void {
  const runtime = { ...((options.runtime as Record<string, unknown> | undefined) ?? {}) };
  const labels = Array.isArray(runtime.labels) ? [...(runtime.labels as unknown[])] : [];
  const present = new Set(
    labels
      .map((l) => (typeof l === "object" && l !== null ? (l as Record<string, unknown>).label : undefined))
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.split("=")[0]),
  );
  for (const [key, value] of Object.entries(ownershipEntries(LABEL_OWNERSHIP_KEYS, ownership))) {
    if (present.has(key)) continue;
    labels.push({ label: `${key}=${value}`, nodeFilters: ["all"] });
  }
  runtime.labels = labels;
  options.runtime = runtime;
}

function clusterDocument(
  name: string,
  cluster: Declarable,
  entityNames: Map<Declarable, string>,
  context?: SerializeContext,
): Record<string, unknown> {
  const raw = (isResourceDeclarable(cluster) ? cluster.props : {}) as Record<string, unknown>;
  const props = (walkValue(raw, entityNames, visitor) ?? {}) as Record<string, unknown>;

  const doc: Record<string, unknown> = {};
  doc.apiVersion = props.apiVersion ?? API_VERSION;
  doc.kind = props.kind ?? KIND;

  // metadata.name defaults from the entity's declared name — the schema wants
  // a hostname there and the export name is the one identity the author has
  // already chosen. An explicit metadata wins untouched.
  const metadata = props.metadata as Record<string, unknown> | undefined;
  doc.metadata = metadata?.name !== undefined ? metadata : { ...(metadata ?? {}), name: name };

  for (const key of KEY_ORDER) {
    if (key === "apiVersion" || key === "kind" || key === "metadata" || key === "options") continue;
    if (props[key] !== undefined) doc[key] = props[key];
  }

  const options = { ...((props.options as Record<string, unknown> | undefined) ?? {}) };
  if (options.kubeconfig === undefined) {
    // chant's deliberate inversion of upstream's true/true — see module doc.
    options.kubeconfig = { updateDefaultKubeconfig: false, switchCurrentContext: false };
  }
  if (context?.ownership) stampOwnership(options, context.ownership);
  doc.options = options;

  // Anything declared outside the known order still emits — the schema is
  // additionalProperties: false, so this only ever carries what a future
  // schema version adds before KEY_ORDER learns about it.
  for (const [key, value] of Object.entries(props)) {
    if (KEY_ORDER.includes(key) || value === undefined) continue;
    doc[key] = value;
  }

  return doc;
}

function emitDocument(doc: Record<string, unknown>): string {
  const sections: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sections.push(`${key}: ${scalar(value)}`);
    } else {
      sections.push(`${key}:` + emitYAML(value, 1));
    }
  }
  return sections.join("\n") + "\n";
}

function scalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (/[:#\[\]{}|>&*!%@`'"]|^[\s\d]|\s$|^$|^(true|false|null|yes|no|on|off)$/i.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export const k3dSerializer: Serializer = {
  name: "k3d",
  rulePrefix: "K3D",

  serialize(
    entities: Map<string, Declarable>,
    _outputs?: LexiconOutput[],
    context?: SerializeContext,
  ): string | SerializerResult {
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) entityNames.set(entity, name);

    const clusters = [...entities].filter(([, e]) => e.entityType === CLUSTER_TYPE);

    let primary = "";
    const files: Record<string, string> = {};
    clusters.forEach(([name, cluster], i) => {
      const content = emitDocument(clusterDocument(name, cluster, entityNames, context));
      if (i === 0) primary = content;
      else files[`${name}.k3d.yaml`] = content;
    });

    return Object.keys(files).length > 0 ? { primary, files } : primary;
  },
};
