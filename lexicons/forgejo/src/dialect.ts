/**
 * Forgejo dialect transform.
 *
 * Forgejo Actions (the engine behind Codeberg, self-hosted Forgejo, and Gitea)
 * runs GitHub-Actions-compatible YAML, so the github lexicon's serializer emits
 * the right shape. The dialect differs in three small ways, all handled here as
 * a pre-pass over the resolved entity graph before the github serializer runs:
 *
 *  1. `continue-on-error` is silently ignored by the Forgejo runner — we drop
 *     it from the output and warn per occurrence. `permissions` is reduced to
 *     the one scope a Forgejo job can still use: `id-token`, which a job that
 *     assumes a cloud role over OIDC needs (#3500). Every other scope
 *     (`contents`, `pull-requests`, ...) is dropped without a warning, since
 *     Forgejo reads none of them and flags the key in the run page's
 *     "Workflow warnings" box. A `permissions` block with no `id-token` goes
 *     away whole; one with it keeps only that line.
 *  2. GitHub-hosted runner labels (`ubuntu-latest`, …) have no fixed meaning on
 *     Forgejo — we map them to a default Forgejo label, overridable per project.
 *  3. Anything we can't place (an unmapped runner label) passes through with a
 *     warning rather than being dropped.
 *
 * Operating on the entity graph (rather than string-munging YAML) keeps the
 * transform faithful: the github serializer still does the actual emission.
 */

// chant#2444 — core's `isDeclarable`, not a local copy. This file carried its
// own, testing only that the marker was PRESENT where core also requires it to
// be `true`, so the two disagreed about a value carrying `false`. Core's also
// accepts an entity a host built, which a local identity check cannot.
import { isDeclarable, isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import { resolveActionRef } from "./actions";

/**
 * Keys the Forgejo runner ignores. Emitting them is misleading (they look
 * enforced but aren't), so the dialect drops them. Compared in kebab-case so
 * both `continueOnError` and `continue-on-error` spellings are caught.
 * `permissions` is handled apart, by {@link reducePermissions}.
 */
const DROPPED_KEYS = new Set(["continue-on-error"]);

/** The one `permissions` scope kept: a job needs it to request an OIDC token. */
const KEPT_PERMISSION = "id-token";

const PERMISSION_LEVELS = new Set(["read", "write", "none"]);

/**
 * True for a GitHub `permissions` value: `read-all`/`write-all`, or a map of
 * scope to `read`/`write`/`none`. Anything else (an action's `with: {
 * permissions: ... }` input, say) is not one and passes through untouched.
 */
function isPermissionsValue(value: unknown): boolean {
  if (typeof value === "string") return value === "read-all" || value === "write-all";
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return entries.every((v) => typeof v === "string" && PERMISSION_LEVELS.has(v));
}

/**
 * Reduce a `permissions` value to what Forgejo can use: the `id-token` scope,
 * or `undefined` when there is none (the caller then omits the key).
 */
function reducePermissions(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const scope = (value as Record<string, unknown>)[KEPT_PERMISSION];
  return scope === undefined ? undefined : { [KEPT_PERMISSION]: scope };
}

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
    if (kebab === "permissions" && isPermissionsValue(v)) {
      const kept = reducePermissions(v);
      if (kept) result[key] = kept;
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
  const rawProps = isResourceDeclarable(entity) ? entity.props : undefined;
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
