/**
 * Forgejo dialect transform.
 *
 * Forgejo Actions (the engine behind Codeberg, self-hosted Forgejo, and Gitea)
 * runs GitHub-Actions-compatible YAML, so the github lexicon's serializer emits
 * the right shape. The dialect differs in three small ways, all handled here as
 * a pre-pass over the resolved entity graph before the github serializer runs:
 *
 *  1. `permissions` and `continue-on-error` are silently ignored by the Forgejo
 *     runner — we drop them from the output and warn per occurrence.
 *  2. GitHub-hosted runner labels (`ubuntu-latest`, …) have no fixed meaning on
 *     Forgejo — we map them to a default Forgejo label, overridable per project.
 *  3. Anything we can't place (an unmapped runner label) passes through with a
 *     warning rather than being dropped.
 *
 * Operating on the entity graph (rather than string-munging YAML) keeps the
 * transform faithful: the github serializer still does the actual emission.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { resolveActionRef } from "./actions";

/**
 * Keys the Forgejo runner ignores. Emitting them is misleading (they look
 * enforced but aren't), so the dialect drops them. Compared in kebab-case so
 * both `continueOnError` and `continue-on-error` spellings are caught.
 */
const DROPPED_KEYS = new Set(["permissions", "continue-on-error"]);

/** Property key whose value is a runner-label selector. */
const RUNS_ON_KEY = "runs-on";

/** Property key whose value is an action/workflow reference. */
const USES_KEY = "uses";

/**
 * Default GitHub-hosted runner label → Forgejo label mapping. `docker` is the
 * label a freshly-registered Forgejo `act_runner` exposes, and the one used
 * throughout the Forgejo Actions docs, so it is the safest default target.
 * Override per project via `forgejo.runnerLabels` in `chant.config.ts`.
 */
export const DEFAULT_RUNNER_LABELS: Record<string, string> = {
  "ubuntu-latest": "docker",
  "ubuntu-24.04": "docker",
  "ubuntu-22.04": "docker",
  "ubuntu-20.04": "docker",
};

export interface ForgejoDialectOptions {
  /** Project-supplied label overrides, merged over {@link DEFAULT_RUNNER_LABELS}. */
  runnerLabels?: Record<string, string>;
  /** Base for resolving mirrored `uses:` action refs (see ./actions). */
  actionsRoot?: string;
}

export interface ForgejoDialectResult {
  /** The transformed entity map (clones; originals are not mutated). */
  entities: Map<string, Declarable>;
  /** One warning per dropped key and per unmapped runner label. */
  warnings: string[];
}

/** Convert a camelCase or kebab-case key to a canonical kebab-case form. */
function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function isDeclarable(value: unknown): value is Declarable {
  return typeof value === "object" && value !== null && DECLARABLE_MARKER in value;
}

interface TransformCtx {
  labels: Record<string, string>;
  actionsRoot?: string;
  warnings: string[];
  /** Human-readable location used in warning messages. */
  where: string;
}

/**
 * Map a single runner label, passing it through unchanged when unmapped. An
 * unmapped label that survives into the output is reported by the WFJ011
 * post-synth check (which surfaces in both `chant build` and `chant lint`),
 * so the dialect doesn't also warn here — that would double-report.
 */
function mapLabel(label: string, ctx: TransformCtx): string {
  return ctx.labels[label] ?? label;
}

/** Remap a `runs-on` value (string or string[]); leave other shapes untouched. */
function remapRunsOn(value: unknown, ctx: TransformCtx): unknown {
  if (typeof value === "string") return mapLabel(value, ctx);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (value as string[]).map((v) => mapLabel(v, ctx));
  }
  return value;
}

function transformValue(value: unknown, ctx: TransformCtx): unknown {
  if (value === null || typeof value !== "object") return value;

  if (isDeclarable(value)) return cloneDeclarable(value, ctx);

  if (Array.isArray(value)) return value.map((v) => transformValue(v, ctx));

  // Plain object: drop ignored keys, remap runs-on, recurse into the rest.
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const kebab = toKebabCase(key);
    if (DROPPED_KEYS.has(kebab)) {
      ctx.warnings.push(
        `forgejo: dropped '${kebab}' in ${ctx.where} — the Forgejo runner ignores it. ` +
          `Re-establish this control through your Forgejo/runner configuration.`,
      );
      continue;
    }
    if (kebab === RUNS_ON_KEY) {
      result[key] = remapRunsOn(v, ctx);
      continue;
    }
    if (kebab === USES_KEY && typeof v === "string") {
      // Rewrite to a Forgejo-resolvable form. An unresolved ref that survives
      // is reported by the WFJ010 post-synth check (build + lint), so the
      // dialect doesn't also warn here — that would double-report.
      result[key] = resolveActionRef(v, { actionsRoot: ctx.actionsRoot }).rewritten;
      continue;
    }
    result[key] = transformValue(v, ctx);
  }
  return result;
}

/** Shallow-clone a Declarable, replacing its `props` with a transformed copy. */
function cloneDeclarable(entity: Declarable, ctx: TransformCtx): Declarable {
  const descriptors = Object.getOwnPropertyDescriptors(entity);
  const clone = Object.create(Object.getPrototypeOf(entity), descriptors) as Declarable;
  const rawProps = (entity as unknown as { props?: unknown }).props;
  const newProps = transformValue(rawProps, ctx);
  Object.defineProperty(clone, "props", {
    value: newProps,
    enumerable: descriptors.props?.enumerable ?? false,
    configurable: true,
    writable: descriptors.props?.writable ?? true,
  });
  return clone;
}

export interface TransformObjectResult {
  /** The transformed plain value (clone; the input is not mutated). */
  value: unknown;
  /** One warning per dropped key, unmapped label, and unresolved action ref. */
  warnings: string[];
}

/**
 * Apply the Forgejo dialect to a plain object — e.g. a parsed GitHub Actions
 * workflow during migration, rather than the resolved entity graph. Same
 * rules as {@link applyForgejoDialect}: drop ignored keys, remap runner
 * labels, resolve `uses:` refs.
 */
export function transformWorkflowObject(
  obj: unknown,
  options: ForgejoDialectOptions = {},
): TransformObjectResult {
  const labels = { ...DEFAULT_RUNNER_LABELS, ...(options.runnerLabels ?? {}) };
  const warnings: string[] = [];
  const ctx: TransformCtx = { labels, actionsRoot: options.actionsRoot, warnings, where: "workflow" };
  return { value: transformValue(obj, ctx), warnings };
}

/**
 * Apply the Forgejo dialect to a resolved entity map. Returns transformed
 * clones plus the diagnostics produced (dropped keys, unmapped labels).
 */
export function applyForgejoDialect(
  entities: Map<string, Declarable>,
  options: ForgejoDialectOptions = {},
): ForgejoDialectResult {
  const labels = { ...DEFAULT_RUNNER_LABELS, ...(options.runnerLabels ?? {}) };
  const warnings: string[] = [];
  const out = new Map<string, Declarable>();

  for (const [name, entity] of entities) {
    const ctx: TransformCtx = { labels, actionsRoot: options.actionsRoot, warnings, where: name };
    out.set(name, cloneDeclarable(entity, ctx));
  }

  return { entities: out, warnings };
}
