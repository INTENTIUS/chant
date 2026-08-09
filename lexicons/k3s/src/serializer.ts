/**
 * k3s config YAML serializer.
 *
 * Emits the files k3s consumes verbatim — the walk-away artifacts that
 * justify a lexicon here at all (#1600):
 *
 *   K3s::Server / K3s::Agent → config.yaml   (`k3s server --config <file>`)
 *   K3s::Registries          → registries.yaml
 *
 * One document per declared entity: the first config is the primary
 * output, every further entity lands in files[] keyed `<name>.config.yaml`
 * / `<name>.registries.yaml`. A config.yaml's keys are exactly the CLI
 * flag names, so the emitted file diffs cleanly against any hand-written
 * one and `k3s check-config` style tooling sees nothing unusual.
 *
 * ## Ownership rides node-label (#1603)
 *
 * config.yaml has no free-form metadata channel, but `node-label` is a
 * first-class key on both server and agent and lands on the registered
 * Node as ordinary Kubernetes labels. When a build carries ownership,
 * the serializer appends the chant label pair to `node-label` — readable
 * back through any kubectl against the cluster, and inert to k3s itself.
 * An author's own label with the same key wins.
 *
 * ## What never appears
 *
 * `token` / `agent-token` literals are not part of the typed surface
 * (#1601), and K3SC001 fails the build if one arrives through untyped
 * props anyway. The file k3s reads secrets from is the file's business
 * (`token-file`), not the artifact's.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult, SerializeContext } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitYAML } from "@intentius/chant/yaml";
import { ownershipEntries, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";

export const SERVER_TYPE = "K3s::Server";
export const AGENT_TYPE = "K3s::Agent";
export const REGISTRIES_TYPE = "K3s::Registries";

/**
 * Keys that lead the document; everything else follows alphabetically.
 * The identity-and-join block first is how the documented examples read,
 * so a chant emission diffs cleanly against them.
 */
const KEY_PRIORITY = [
  "cluster-init",
  "server",
  "token-file",
  "agent-token-file",
  "data-dir",
  "node-name",
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

function orderedKeys(props: Record<string, unknown>): string[] {
  const rest = Object.keys(props)
    .filter((k) => !KEY_PRIORITY.includes(k))
    .sort();
  return [...KEY_PRIORITY.filter((k) => props[k] !== undefined), ...rest];
}

/**
 * Append the ownership marker to `node-label`. The key survives into the
 * registered Node's labels, which is the only durable channel a host
 * config file has. An author-set key of the same name wins.
 */
function stampOwnership(
  props: Record<string, unknown>,
  ownership: NonNullable<SerializeContext["ownership"]>,
): void {
  const existing = props["node-label"];
  const labels: string[] =
    existing === undefined ? [] : Array.isArray(existing) ? [...(existing as string[])] : [String(existing)];
  const present = new Set(labels.map((l) => String(l).split("=")[0]));
  for (const [key, value] of Object.entries(ownershipEntries(LABEL_OWNERSHIP_KEYS, ownership))) {
    if (present.has(key)) continue;
    labels.push(`${key}=${value}`);
  }
  props["node-label"] = labels;
}

function configDocument(
  entity: Declarable,
  entityNames: Map<Declarable, string>,
  context?: SerializeContext,
): Record<string, unknown> {
  const raw = (isResourceDeclarable(entity) ? entity.props : {}) as Record<string, unknown>;
  const props = (walkValue(raw, entityNames, visitor) ?? {}) as Record<string, unknown>;
  if (context?.ownership) stampOwnership(props, context.ownership);

  const doc: Record<string, unknown> = {};
  for (const key of orderedKeys(props)) {
    if (props[key] !== undefined) doc[key] = props[key];
  }
  return doc;
}

function registriesDocument(
  entity: Declarable,
  entityNames: Map<Declarable, string>,
): Record<string, unknown> {
  const raw = (isResourceDeclarable(entity) ? entity.props : {}) as Record<string, unknown>;
  const props = (walkValue(raw, entityNames, visitor) ?? {}) as Record<string, unknown>;
  const doc: Record<string, unknown> = {};
  // mirrors before configs, matching the documented examples.
  if (props.mirrors !== undefined) doc.mirrors = props.mirrors;
  if (props.configs !== undefined) doc.configs = props.configs;
  for (const [key, value] of Object.entries(props)) {
    if (key === "mirrors" || key === "configs" || value === undefined) continue;
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

export const k3sSerializer: Serializer = {
  name: "k3s",
  rulePrefix: "K3S",

  serialize(
    entities: Map<string, Declarable>,
    _outputs?: LexiconOutput[],
    context?: SerializeContext,
  ): string | SerializerResult {
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) entityNames.set(entity, name);

    const configs = [...entities].filter(
      ([, e]) => e.entityType === SERVER_TYPE || e.entityType === AGENT_TYPE,
    );
    const registries = [...entities].filter(([, e]) => e.entityType === REGISTRIES_TYPE);

    let primary = "";
    const files: Record<string, string> = {};

    configs.forEach(([name, entity], i) => {
      const content = emitDocument(configDocument(entity, entityNames, context));
      if (i === 0) primary = content;
      else files[`${name}.config.yaml`] = content;
    });

    registries.forEach(([name, entity], i) => {
      const content = emitDocument(registriesDocument(entity, entityNames));
      if (primary === "" && i === 0 && configs.length === 0) primary = content;
      else files[i === 0 && configs.length > 0 ? "registries.yaml" : `${name}.registries.yaml`] = content;
    });

    return Object.keys(files).length > 0 ? { primary, files } : primary;
  },
};
