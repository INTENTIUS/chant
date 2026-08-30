/**
 * cpln serializer — emits the multi-document YAML that `cpln apply --file`
 * consumes.
 *
 * Each declared resource becomes one document:
 *
 *   kind: workload
 *   name: my-app
 *   gvc: my-gvc
 *   tags:
 *     chant.intentius.io/managed-by: chant
 *   spec:
 *     containers:
 *       - name: main
 *         image: nginx:1.27
 *
 * Three things this file is careful about.
 *
 * **Only authoring surface is emitted.** Control Plane's own guidance is to
 * export with `-o yaml-slim` rather than `-o yaml` before re-applying, because
 * the server-side fields (`status`, `id`, `created`, `lastModified`, `links`)
 * break `cpln apply`. Those are attributes in this lexicon rather than
 * properties, so they never reach a document in the first place — the shape a
 * user can declare is already the slim shape.
 *
 * **References become links, not names.** Control Plane addresses resources by
 * link (`//gvc/prod/identity/api`, `//secret/db-password`), and the GVC-scoped
 * forms have to carry the GVC. Passing a declared resource where a link is
 * expected resolves to the right link for its kind, which is the difference
 * between a reference that survives a rename and a hand-spelled string that
 * does not. The identity form matters especially: the bare `//identity/NAME`
 * that reads perfectly plausibly is *silently ignored* by Control Plane's
 * policy engine, and is documented as a common silent failure.
 *
 * **Document order is stable and dependency-first.** `cpln apply` resolves
 * ordering itself for a multi-doc file, so this is not needed for correctness —
 * it is so the emitted file diffs cleanly between builds and reads in the order
 * a person would write it.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializeContext } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { ownershipEntries } from "@intentius/chant/ownership";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitYAML } from "@intentius/chant/yaml";
import { KINDS, kindByTypeName, type CplnKind } from "./kinds";
import { CPLN_TAG_OWNERSHIP_KEYS } from "./ownership";

/**
 * Document order: a GVC before anything inside it, and the org-scoped assets a
 * workload references before the workload. Matches the order the API would
 * accept the documents in one at a time.
 */
const KIND_ORDER: string[] = ["gvc", "secret", "ipset", "policy", "identity", "volumeset", "workload", "domain"];

/**
 * Manifest key order. `kind` and `name` first because that is how every
 * Control Plane example reads; `spec` last because it is the long one.
 */
const KEY_ORDER: string[] = ["kind", "name", "description", "gvc", "tags"];

/** Properties consumed to build the envelope rather than copied into the body. */
const ENVELOPE_KEYS = new Set(["name", "description", "gvc", "tags"]);

/**
 * `satisfies` rather than a type annotation: `Serializer.serialize` returns
 * `string | SerializerResult`, and cpln always emits a single YAML string.
 * Annotating widens the export to the union and every caller — the tests
 * included — has to narrow it back with a cast that asserts something the
 * implementation already guarantees. `satisfies` checks the shape against the
 * interface and keeps the narrower return type.
 */
export const cplnSerializer = {
  name: "cpln",
  rulePrefix: "CPL",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[], context?: SerializeContext): string {
    // The walker wants Declarable → name; link resolution wants the inverse.
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) entityNames.set(entity, name);

    const visitor = cplnVisitor(entities);

    const documents: Array<{ order: number; name: string; text: string }> = [];

    for (const [entityName, entity] of entities) {
      const kind = kindByTypeName(entity.entityType);
      // Not ours. A build can mix lexicons, and each serializer sees only the
      // entities routed to it, but skipping defensively costs nothing.
      if (!kind) continue;

      const props = readProps(entity);
      const manifest: Record<string, unknown> = { kind: kind.kind };

      // `name` falls back to the entity's own name, so a resource declared
      // without one still round-trips rather than emitting `name: undefined`.
      manifest.name = props.name ?? entityName;

      if (props.description !== undefined) manifest.description = walkValue(props.description, entityNames, visitor);
      if (kind.gvcScoped) manifest.gvc = walkValue(props.gvc, entityNames, visitor);

      const tags = buildTags(props.tags, entityNames, visitor, context);
      if (tags) manifest.tags = tags;

      for (const [key, value] of Object.entries(props)) {
        if (ENVELOPE_KEYS.has(key) || value === undefined) continue;
        manifest[key] = walkValue(value, entityNames, visitor);
      }

      documents.push({
        order: KIND_ORDER.indexOf(kind.kind),
        name: String(manifest.name),
        text: emitManifest(manifest),
      });
    }

    documents.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    return documents.map((d) => d.text).join("\n---\n");
  },
} satisfies Serializer;

// ── Tags and ownership ─────────────────────────────────────────────

/**
 * Merge the declared tags with chant's ownership marker.
 *
 * The marker is stamped even when the resource declares no tags of its own —
 * that is the whole point of it, since an unmarked resource is invisible to
 * the owned-resource prune that lets `chant delete` be precise without a state
 * file.
 */
function buildTags(
  declared: unknown,
  entityNames: Map<Declarable, string>,
  visitor: SerializerVisitor,
  context?: SerializeContext,
): Record<string, unknown> | undefined {
  const walked = declared === undefined ? undefined : walkValue(declared, entityNames, visitor);
  const tags: Record<string, unknown> =
    walked && typeof walked === "object" && !Array.isArray(walked) ? { ...(walked as Record<string, unknown>) } : {};

  if (context?.ownership) {
    Object.assign(tags, ownershipEntries(CPLN_TAG_OWNERSHIP_KEYS, context.ownership));
  }

  return Object.keys(tags).length > 0 ? tags : undefined;
}

// ── References ─────────────────────────────────────────────────────

/**
 * Build the Control Plane link for a declared resource.
 *
 * GVC-scoped kinds nest under their GVC. For identities in particular the
 * nested form is not cosmetic: a policy binding written against the bare
 * `//identity/NAME` is accepted and then ignored.
 */
export function cplnLink(kind: CplnKind, name: string, gvc?: unknown): string {
  if (kind.kind === "gvc") return `//gvc/${name}`;
  if (kind.gvcScoped) {
    if (typeof gvc !== "string" || gvc.length === 0) {
      throw new Error(
        `Cannot build a link to ${kind.kind} "${name}": its \`gvc\` is not a plain string at build time. ` +
          `GVC-scoped links must be \`//gvc/<gvc>/${kind.kind}/<name>\`, and the bare \`//${kind.kind}/<name>\` ` +
          `form is silently ignored by Control Plane.`,
      );
    }
    return `//gvc/${gvc}/${kind.kind}/${name}`;
  }
  return `//${kind.kind}/${name}`;
}

/**
 * Visitor for the generic serializer walker.
 *
 * Property declarables unwrap to plain objects; resource references resolve to
 * Control Plane links; attribute references have nowhere to go.
 */
function cplnVisitor(entities: Map<string, Declarable>): SerializerVisitor {
  const linkFor = (logicalName: string): string => {
    const target = entities.get(logicalName);
    const kind = target && kindByTypeName(target.entityType);
    if (!target || !kind) {
      // A reference to something this lexicon does not model. The logical name
      // is the most useful thing left to emit, and a post-synth check reports
      // links that do not resolve.
      return logicalName;
    }
    const props = readProps(target);
    const name = typeof props.name === "string" ? props.name : logicalName;
    return cplnLink(kind, name, props.gvc);
  };

  return {
    attrRef: (name, attribute) => {
      throw new Error(
        `Cannot serialize a reference to ${name}.${attribute}: Control Plane manifests have no ` +
          `template-time reference language, so an attribute known only after apply cannot be embedded in one. ` +
          `Reference the resource itself — it resolves to a link — or read the attribute after apply.`,
      );
    },
    resourceRef: linkFor,
    propertyDeclarable: (entity, walk) => {
      const props = isResourceDeclarable(entity) ? entity.props : undefined;
      if (!props || typeof props !== "object") return undefined;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) result[key] = walk(value);
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
  };
}

// ── Emission ───────────────────────────────────────────────────────

function readProps(entity: Declarable): Record<string, unknown> {
  const props = isResourceDeclarable(entity) ? entity.props : undefined;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

/** Emit one manifest document, ordered keys first and the rest alphabetically. */
function emitManifest(manifest: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const key of KEY_ORDER) {
    if (manifest[key] !== undefined) lines.push(emitKeyValue(key, manifest[key]));
  }

  const rest = Object.keys(manifest)
    .filter((k) => !KEY_ORDER.includes(k))
    .sort();
  for (const key of rest) {
    if (manifest[key] !== undefined) lines.push(emitKeyValue(key, manifest[key]));
  }

  return `${lines.join("\n")}\n`;
}

/** Scalars get `key: value`; blocks get the value indented beneath the key. */
function emitKeyValue(key: string, value: unknown): string {
  const yaml = emitYAML(value, 1);
  return yaml.startsWith("\n") ? `${key}:${yaml}` : `${key}: ${yaml}`;
}

/** Kind order used for document sorting, exported for the serializer tests. */
export const DOCUMENT_KIND_ORDER: readonly string[] = KIND_ORDER;

/** Every modelled kind, re-exported so consumers need not reach into `kinds`. */
export const SERIALIZED_KINDS = KINDS;
