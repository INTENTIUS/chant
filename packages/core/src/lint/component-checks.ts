/**
 * Component composition checks — the COMP* rule family (#562, epic #551).
 *
 * COR/EVL rules (./rule.ts, ./engine.ts) check one `ts.SourceFile`'s AST in
 * isolation, synchronously — no execution, no cross-file knowledge. A COMP*
 * rule cannot work that way: "publishes but never applies", "`imageRef`
 * points at a nonexistent phase", and "identical composition repeated across
 * components" are all properties of the *discovered component graph*, which
 * only exists after `*.component.ts` files are actually imported (mirroring
 * `../components/discover.ts`'s `discoverComponents`, itself async for the
 * same reason `../discovery/index.ts`'s `discover()` is).
 *
 * Rather than stretch `LintRule.check(context)` (sync, single-file, AST-only)
 * to cover this, COMP* rules follow the precedent chant already has for
 * "check something that needs real, resolved, whole-project data":
 * `./post-synth.ts`'s `PostSynthCheck`/`PostSynthContext`/`runPostSynthChecks`,
 * which wraps a real (async) build result for a sync `check(ctx)` call. This
 * module is that same shape, one layer earlier in the pipeline — over the
 * discovered `Component` graph instead of serialized resource output — so
 * `chant lint` (not just `chant build`) can run it. See
 * ../components/discover.ts's own docstring for why `Component` gets a
 * parallel, purpose-built convention rather than reusing `Declarable`'s.
 */

import type { Component } from "../components/component";
import type { DiscoveredComponent } from "../components/discover";
import { discoverComponents } from "../components/discover";
import type { RollbackPolicy } from "../components/capability";
import type { Severity } from "./rule";

/** One discovered component, keyed by its declared name, with the file it came from. */
export interface ComponentCheckEntry {
  component: Component;
  filePath: string;
}

/** Context handed to a `ComponentCheck` — the whole discovered component graph for one project. */
export interface ComponentCheckContext {
  /** Every discovered component, keyed by `component.name`. */
  components: Map<string, ComponentCheckEntry>;
  /**
   * Every capability `kind` registered for this project — core's starter set
   * plus whatever the active lexicons contribute (e.g. `cfn-deploy` when
   * `lexicons: ["aws"]`). Supplied by the `chant lint` CLI, which builds the
   * registry from the project's config; undefined when a check runs without a
   * resolved registry (e.g. a direct unit test), in which case a rule should
   * fall back to core's starter set. Rules that key off "is this a known verb"
   * (e.g. COMP005) read this rather than hard-coding a verb list.
   */
  knownKinds?: ReadonlySet<string>;
  /**
   * Each registered verb's rollback disposition (`native`/`none-by-design`/
   * `needs-opt-out`), derived from the project's capability registry the same
   * way `knownKinds` is. Read by COMP003 instead of a hard-coded verb list;
   * undefined when no registry was resolved (a check then treats every kind as
   * `none-by-design`, i.e. flags nothing).
   */
  rollbackPolicies?: ReadonlyMap<string, RollbackPolicy>;
}

/** A diagnostic from a component composition check. Shaped like `PostSynthDiagnostic`, plus a `file` so it can be merged into `LintDiagnostic`s and reported per-file like every other lint diagnostic. */
export interface ComponentCheckDiagnostic {
  /** ID of the check that produced this diagnostic (e.g. "COMP001"). */
  checkId: string;
  severity: Severity;
  message: string;
  /** File the discovered component was declared in — where the diagnostic is reported. */
  file: string;
  /** The component name this diagnostic concerns. */
  component: string;
}

/** A composition-level lint check over the whole discovered component graph. */
export interface ComponentCheck {
  /** Unique identifier, e.g. "COMP001". */
  id: string;
  description: string;
  severity: Severity;
  category: "correctness" | "style" | "performance" | "security";
  /** Execute the check and return diagnostics. */
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[];
}

/**
 * Discover every component under `path` and run every `ComponentCheck`
 * against the resulting graph. Mirrors `runPostSynthChecks`'s shape
 * (async discovery/build once, then every check runs sync over the result),
 * except the input is `discoverComponents`'s result rather than a build's
 * serialized output.
 *
 * Discovery errors (e.g. a duplicate component name, a `*.component.ts` file
 * that throws on import) are surfaced as a single synthetic diagnostic per
 * error under the pseudo-check id "COMP000" rather than silently dropped —
 * matching how `discoverComponents`'s caller (`../components/cli-support.ts`)
 * always surfaces `result.errors` rather than ignoring them.
 *
 * `sandbox` (chant #1051, `chant lint --sandbox`) is threaded straight
 * through to `discoverComponents` — `chant lint`'s own AST-only rule engine
 * never executes project source (see this module's own doc comment), but
 * COMP* checks exist precisely because they need the discovered `Component`
 * graph, which does mean importing `*.component.ts` files.
 */
export async function runComponentChecks(
  path: string,
  checks: ComponentCheck[],
  registryContext?: Pick<ComponentCheckContext, "knownKinds" | "rollbackPolicies">,
  sandbox?: boolean,
): Promise<ComponentCheckDiagnostic[]> {
  if (checks.length === 0) return [];

  const result = await discoverComponents(path, { sandbox });
  const diagnostics: ComponentCheckDiagnostic[] = [];

  for (const err of result.errors) {
    diagnostics.push({
      checkId: "COMP000",
      severity: "error",
      message: `Component discovery error: ${err.message}`,
      file: err.file,
      component: "(unknown)",
    });
  }

  const components = new Map<string, ComponentCheckEntry>();
  for (const [name, discovered] of result.components) {
    components.set(name, { component: discovered.component, filePath: discovered.filePath });
  }

  const ctx: ComponentCheckContext = {
    components,
    knownKinds: registryContext?.knownKinds,
    rollbackPolicies: registryContext?.rollbackPolicies,
  };
  for (const check of checks) {
    diagnostics.push(...check.check(ctx));
  }

  return diagnostics;
}

/** Structural type guard, mirroring `isPostSynthCheck` — used by rule discovery/registry code. */
export function isComponentCheck(value: unknown): value is ComponentCheck {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.description === "string" &&
    typeof v.severity === "string" &&
    typeof v.category === "string" &&
    typeof v.check === "function"
  );
}

/** Re-exported for rule modules that need the discovered shape without importing `../components/discover` directly. */
export type { DiscoveredComponent };
