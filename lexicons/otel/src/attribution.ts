/**
 * OTEL118: a collector processor that can remove or replace a resource
 * attribute chant's telemetry attribution stamps (ws-060, #3375).
 *
 * A workload built inside a workspace carries `service.name`,
 * `service.version`, `deployment.environment.name`, `vcs.ref.head.revision`
 * and `chant.*` keys on its resource. hud and behold join a span to a member,
 * a release and a graph node by them. A collector between the workload and the
 * backend can undo that, and these are the processors that can:
 *
 * - `resource`: a `delete`, `update`, `upsert` or `hash` action on a protected
 *   `key`, or a `delete` or `hash` whose `pattern` matches one. `insert` only
 *   adds a missing key. `extract` writes the pattern's named groups, and an RE2
 *   group name has no dot, so it can't name a protected key.
 * - `transform`: an OTTL statement on the resource's attributes that calls
 *   `set`, `delete_key` or `delete_matching_keys` on a protected key, or
 *   `keep_keys` or `keep_matching_keys` that leaves one out. This is a text
 *   match over the statement, not a parse.
 * - `resourcedetection` with `override` on (its default at contrib v0.130.0,
 *   `factory.go` `createDefaultConfig`) and a detector that can write a
 *   protected key: `env` (the collector's own `OTEL_RESOURCE_ATTRIBUTES`, and
 *   the default detector list), `dynatrace` (any key in its properties file),
 *   `heroku` (`service.name`, `service.version`) and `elastic_beanstalk`
 *   (`service.version`), per each detector's `metadata.yaml` at that tag.
 *
 * The `attributes` processor acts on span, log and metric attributes, not the
 * resource's, so it is not checked. Only processors some pipeline lists are.
 */

import { TELEMETRY_ATTRIBUTES } from "@intentius/chant/telemetry-attribution";
import { canonicalTypeOf, type CollectorConfig } from "./model";
import type { CollectorIssue } from "./validate-config";

/** The keys the attribution stamps. Any other `chant.*` key is protected too. */
export const PROTECTED_RESOURCE_ATTRIBUTES: readonly string[] = TELEMETRY_ATTRIBUTES.map((a) => a.key);

/** True for a key OTEL118 protects: one of `PROTECTED_RESOURCE_ATTRIBUTES`, or any `chant.*` key. */
export function isProtectedResourceAttribute(key: string): boolean {
  return PROTECTED_RESOURCE_ATTRIBUTES.includes(key) || key.startsWith("chant.");
}

/** The protected keys a regular expression matches. An RE2 pattern JavaScript can't compile matches none. */
function protectedMatching(pattern: string): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return [];
  }
  return PROTECTED_RESOURCE_ATTRIBUTES.filter((k) => re.test(k));
}

function quoteAll(keys: string[]): string {
  return keys.map((k) => `"${k}"`).join(", ");
}

const REPLACING_ACTIONS: Record<string, string> = {
  delete: "removes",
  update: "replaces",
  upsert: "replaces",
  hash: "replaces with its hash",
};

function resourceActionFindings(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const actions = Array.isArray(body.attributes) ? body.attributes : [];
  for (const raw of actions) {
    if (typeof raw !== "object" || raw === null) continue;
    const { key, action, pattern } = raw as { key?: unknown; action?: unknown; pattern?: unknown };
    const verb = typeof action === "string" ? REPLACING_ACTIONS[action] : undefined;
    if (!verb) continue;
    if (typeof key === "string" && isProtectedResourceAttribute(key)) {
      out.push(`its ${action} action ${verb} "${key}"`);
    } else if (typeof pattern === "string" && (action === "delete" || action === "hash")) {
      const hit = protectedMatching(pattern);
      if (hit.length > 0) out.push(`its ${action} action's pattern "${pattern}" matches ${quoteAll(hit)}`);
    }
  }
  return out;
}

// ── transform: a text match over OTTL ────────────────────────────────

const OTTL_CALL = /\b(set|delete_key|delete_matching_keys|keep_keys|keep_matching_keys)\s*\(/g;

/** The top-level arguments of the call whose `(` is at `open`, as written. */
function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

/** The OTTL string literals in `text`, unescaped. */
function stringLiterals(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(["\\])/g, "$1"));
}

/**
 * Whether `path` is the resource's attribute map, and the key it indexes.
 * `resource.attributes` always is; a bare `attributes` is only in a statement
 * group whose context is `resource`.
 */
function resourcePath(path: string, resourceContext: boolean): { key?: string } | undefined {
  const m = /^(resource\.)?attributes\s*(?:\[\s*"((?:[^"\\]|\\.)*)"\s*\])?$/.exec(path);
  if (!m || (!m[1] && !resourceContext)) return undefined;
  return m[2] === undefined ? {} : { key: m[2].replace(/\\(["\\])/g, "$1") };
}

function statementFindings(statement: string, resourceContext: boolean): string[] {
  const out: string[] = [];
  for (const call of statement.matchAll(OTTL_CALL)) {
    const fn = call[1];
    const args = callArguments(statement, call.index! + call[0].length - 1);
    const target = resourcePath(args[0] ?? "", resourceContext);
    if (!target) continue;
    const [literal] = stringLiterals(args[1] ?? "");
    if (fn === "set") {
      if (target.key === undefined) out.push(`set replaces the whole resource attribute map`);
      else if (isProtectedResourceAttribute(target.key)) out.push(`set replaces "${target.key}"`);
    } else if (target.key !== undefined) {
      continue;
    } else if (fn === "delete_key" && literal !== undefined && isProtectedResourceAttribute(literal)) {
      out.push(`delete_key removes "${literal}"`);
    } else if (fn === "delete_matching_keys" && literal !== undefined) {
      const hit = protectedMatching(literal);
      if (hit.length > 0) out.push(`delete_matching_keys "${literal}" removes ${quoteAll(hit)}`);
    } else if (fn === "keep_keys") {
      const kept = new Set(stringLiterals(args[1] ?? ""));
      const dropped = PROTECTED_RESOURCE_ATTRIBUTES.filter((k) => !kept.has(k));
      if (dropped.length > 0) out.push(`keep_keys drops ${quoteAll(dropped)}`);
    } else if (fn === "keep_matching_keys" && literal !== undefined) {
      const hit = new Set(protectedMatching(literal));
      const dropped = PROTECTED_RESOURCE_ATTRIBUTES.filter((k) => !hit.has(k));
      if (dropped.length > 0) out.push(`keep_matching_keys "${literal}" drops ${quoteAll(dropped)}`);
    }
  }
  return out;
}

function transformFindings(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [field, groups] of Object.entries(body)) {
    if (!field.endsWith("_statements") || !Array.isArray(groups)) continue;
    for (const group of groups) {
      // A plain string infers its context from its paths, so only `resource.` paths reach the resource.
      const [statements, resourceContext] =
        typeof group === "string"
          ? [[group], false]
          : typeof group === "object" && group !== null
            ? [(group as { statements?: unknown }).statements, (group as { context?: unknown }).context === "resource"]
            : [[], false];
      if (!Array.isArray(statements)) continue;
      for (const statement of statements) {
        if (typeof statement !== "string") continue;
        for (const finding of statementFindings(statement, resourceContext)) {
          out.push(`the OTTL text \`${statement}\` matches a call where ${finding}`);
        }
      }
    }
  }
  return out;
}

// ── resourcedetection ────────────────────────────────────────────────

/** Detectors that can write a protected key, and which. */
const OVERRIDING_DETECTORS: Record<string, string> = {
  env: "any key in the collector's own OTEL_RESOURCE_ATTRIBUTES",
  dynatrace: "any key in the Dynatrace properties file",
  heroku: '"service.name" and "service.version"',
  elastic_beanstalk: '"service.version"',
};

function detectionFindings(body: Record<string, unknown>): string[] {
  // `override` defaults to true, and `detectors` to [env], at contrib v0.130.0.
  if (body.override === false) return [];
  const detectors = Array.isArray(body.detectors) ? body.detectors : ["env"];
  const how = body.override === true ? "override: true" : "override on by default";
  return detectors
    .filter((d): d is string => typeof d === "string" && d in OVERRIDING_DETECTORS)
    .map((d) => `with ${how}, the ${d} detector writes ${OVERRIDING_DETECTORS[d]} over the service's own value; set override: false`);
}

/**
 * OTEL118 over one collector config: each processor a pipeline lists that can
 * remove or replace a protected resource attribute. Not part of
 * `validateCollectorConfig`, because it applies only to a build that stamps
 * the attribution: the post-synth check runs it when the context carries
 * `telemetry`.
 */
export function attributionIssues(config: CollectorConfig): CollectorIssue[] {
  const pipelinesOf = new Map<string, string[]>();
  for (const [pipeline, body] of Object.entries(config.service?.pipelines ?? {})) {
    for (const id of body?.processors ?? []) pipelinesOf.set(String(id), [...(pipelinesOf.get(String(id)) ?? []), pipeline]);
  }
  const issues: CollectorIssue[] = [];
  for (const [id, pipelines] of pipelinesOf) {
    const raw = config.processors?.[id];
    const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const type = canonicalTypeOf("processor", id);
    const findings =
      type === "resource" ? resourceActionFindings(body) : type === "transform" ? transformFindings(body) : type === "resourcedetection" ? detectionFindings(body) : [];
    for (const finding of findings) {
      issues.push({
        code: "OTEL118",
        severity: "warning",
        component: id,
        message: `processor "${id}" (pipelines ${pipelines.join(", ")}): ${finding}. Chant's telemetry attribution stamps those resource attributes, and a span that loses them can't be joined to its member, release or declaration`,
      });
    }
  }
  return issues;
}
