/**
 * Helm template intrinsics.
 *
 * All intrinsics implement INTRINSIC_MARKER and produce `toJSON()` output
 * containing `__helm_tpl` markers that the serializer detects and emits
 * as raw Go template expressions instead of YAML-quoting them.
 */

import { INTRINSIC_MARKER, type Intrinsic } from "@intentius/chant/intrinsic";

// ── Marker key ────────────────────────────────────────────

/** JSON marker key used by the serializer to detect Helm template expressions. */
export const HELM_TPL_KEY = "__helm_tpl";

/** JSON marker key for conditional resource wrappers. */
export const HELM_IF_KEY = "__helm_if";

/** JSON marker key for range loops. */
export const HELM_RANGE_KEY = "__helm_range";

/** JSON marker key for with scopes. */
export const HELM_WITH_KEY = "__helm_with";

// ── HelmTpl base class ────────────────────────────────────

/**
 * Base class for all Helm template expressions.
 *
 * `toJSON()` returns `{ __helm_tpl: "{{ expr }}" }` which the serializer
 * detects and emits as a raw Go template directive.
 */
export class HelmTpl implements Intrinsic {
  readonly [INTRINSIC_MARKER] = true as const;
  readonly expr: string;

  constructor(expr: string) {
    this.expr = expr;
  }

  toJSON(): { __helm_tpl: string } {
    return { [HELM_TPL_KEY]: this.expr };
  }

  /**
   * Pipe this expression through a Go template function.
   * `values.x.pipe("upper").pipe("quote")` → `{{ .Values.x | upper | quote }}`
   */
  pipe(fn: string): HelmTpl {
    // Strip outer {{ }} if present, append pipe, re-wrap
    const inner = this.expr.replace(/^\{\{-?\s*/, "").replace(/\s*-?\}\}$/, "");
    return new HelmTpl(`{{ ${inner} | ${fn} }}`);
  }

  toString(): string {
    return this.expr;
  }
}

// ── Values proxy ──────────────────────────────────────────

/**
 * Create a Proxy-based accessor that records property paths and returns
 * HelmTpl instances for Go template expressions.
 *
 * `values.replicas` → HelmTpl("{{ .Values.replicas }}")
 * `values.image.repository` → HelmTpl("{{ .Values.image.repository }}")
 */
function createValuesProxy(path: string = ".Values"): HelmTpl & Record<string, unknown> {
  const tpl = new HelmTpl(`{{ ${path} }}`);

  return new Proxy(tpl, {
    get(target, prop, receiver) {
      if (prop === INTRINSIC_MARKER) return true;
      if (prop === "toJSON") return () => target.toJSON();
      if (prop === "expr") return target.expr;
      if (prop === "toString") return () => target.toString();
      if (prop === Symbol.toPrimitive) return () => target.expr;

      if (prop === "pipe") {
        return (fn: string) => {
          const piped = new HelmTpl(`{{ ${path} | ${fn} }}`);
          return createPipedProxy(piped, `${path} | ${fn}`);
        };
      }

      if (typeof prop === "string") {
        return createValuesProxy(`${path}.${prop}`);
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as HelmTpl & Record<string, unknown>;
}

/**
 * Create a proxy for piped expressions that allows further chaining.
 */
function createPipedProxy(tpl: HelmTpl, pipedExpr: string): HelmTpl {
  return new Proxy(tpl, {
    get(target, prop, receiver) {
      if (prop === INTRINSIC_MARKER) return true;
      if (prop === "toJSON") return () => target.toJSON();
      if (prop === "expr") return target.expr;
      if (prop === "toString") return () => target.toString();
      if (prop === Symbol.toPrimitive) return () => target.expr;

      if (prop === "pipe") {
        return (fn: string) => {
          const newExpr = `${pipedExpr} | ${fn}`;
          const newTpl = new HelmTpl(`{{ ${newExpr} }}`);
          return createPipedProxy(newTpl, newExpr);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as HelmTpl;
}

/**
 * Values proxy — the primary way to reference Helm values in templates.
 *
 * ```ts
 * values.replicas        // → {{ .Values.replicas }}
 * values.image.tag       // → {{ .Values.image.tag }}
 * values.x.pipe("quote") // → {{ .Values.x | quote }}
 * ```
 */
export const values: Record<string, any> = createValuesProxy();

// ── Built-in objects ──────────────────────────────────────

function createBuiltinObject(prefix: string, fields: string[]): Record<string, HelmTpl> {
  const obj: Record<string, HelmTpl> = {};
  for (const field of fields) {
    obj[field] = new HelmTpl(`{{ ${prefix}.${field} }}`);
  }
  return obj;
}

/**
 * Release built-in object.
 *
 * `Release.Name` → `{{ .Release.Name }}`
 */
export const Release = createBuiltinObject(".Release", [
  "Name", "Namespace", "Service", "IsUpgrade", "IsInstall", "Revision",
]);

/**
 * ChartRef built-in object (named ChartRef to avoid conflict with Chart resource).
 *
 * `ChartRef.Name` → `{{ .Chart.Name }}`
 */
export const ChartRef = createBuiltinObject(".Chart", [
  "Name", "Home", "Sources", "Version", "Description", "Keywords",
  "Maintainers", "Icon", "APIVersion", "Condition", "Tags",
  "AppVersion", "Deprecated", "Annotations", "KubeVersion", "Type",
]);

// ── Nested builtin proxy ─────────────────────────────────

/**
 * Create a Proxy-based accessor for built-in objects with arbitrarily nested
 * property access. Each level returns a new proxy that extends the path.
 *
 * `createNestedBuiltinProxy(".Capabilities").KubeVersion.Version`
 * → HelmTpl("{{ .Capabilities.KubeVersion.Version }}")
 */
function createNestedBuiltinProxy(prefix: string): HelmTpl & Record<string, any> {
  const tpl = new HelmTpl(`{{ ${prefix} }}`);
  return new Proxy(tpl, {
    get(target, prop, receiver) {
      if (prop === INTRINSIC_MARKER) return true;
      if (prop === "toJSON") return () => target.toJSON();
      if (prop === "expr") return target.expr;
      if (prop === "toString") return () => target.toString();
      if (prop === Symbol.toPrimitive) return () => target.expr;
      if (prop === "pipe") {
        return (fn: string) => {
          const inner = prefix;
          const piped = new HelmTpl(`{{ ${inner} | ${fn} }}`);
          return createPipedProxy(piped, `${inner} | ${fn}`);
        };
      }
      if (typeof prop === "string") {
        return createNestedBuiltinProxy(`${prefix}.${prop}`);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as HelmTpl & Record<string, any>;
}

/**
 * Capabilities built-in object — supports arbitrarily nested property access.
 *
 * `Capabilities.KubeVersion.Version` → `{{ .Capabilities.KubeVersion.Version }}`
 * `Capabilities.APIVersions` → `{{ .Capabilities.APIVersions }}`
 * `Capabilities.HelmVersion.Version` → `{{ .Capabilities.HelmVersion.Version }}`
 */
export const Capabilities: Record<string, any> = createNestedBuiltinProxy(".Capabilities");

/**
 * Template built-in object.
 *
 * `Template.Name` → `{{ .Template.Name }}`
 * `Template.BasePath` → `{{ .Template.BasePath }}`
 */
export const Template = createBuiltinObject(".Template", ["Name", "BasePath"]);

// ── Files helpers ────────────────────────────────────────

/**
 * `.Files.Get` — Read a file from the chart directory.
 *
 * `filesGet("config.ini")` → `{{ .Files.Get "config.ini" }}`
 */
export function filesGet(path: string): HelmTpl {
  return new HelmTpl(`{{ .Files.Get "${path}" }}`);
}

/**
 * `.Files.Glob` — Match files by glob pattern.
 *
 * `filesGlob("conf/*")` → `{{ .Files.Glob "conf/*" }}`
 */
export function filesGlob(pattern: string): HelmTpl {
  return new HelmTpl(`{{ .Files.Glob "${pattern}" }}`);
}

/**
 * `.Files.Glob.AsConfig` — Render matched files as ConfigMap data.
 *
 * `filesAsConfig("conf/*")` → `{{ (.Files.Glob "conf/*").AsConfig }}`
 */
export function filesAsConfig(pattern: string): HelmTpl {
  return new HelmTpl(`{{ (.Files.Glob "${pattern}").AsConfig }}`);
}

/**
 * `.Files.Glob.AsSecrets` — Render matched files as Secret data.
 *
 * `filesAsSecrets("conf/*")` → `{{ (.Files.Glob "conf/*").AsSecrets }}`
 */
export function filesAsSecrets(pattern: string): HelmTpl {
  return new HelmTpl(`{{ (.Files.Glob "${pattern}").AsSecrets }}`);
}

// ── Template functions ────────────────────────────────────

/**
 * `include` — Include a named template.
 *
 * `include("my-app.fullname")` → `{{ include "my-app.fullname" . }}`
 */
export function include(name: string, ctx: string = "."): HelmTpl {
  return new HelmTpl(`{{ include "${name}" ${ctx} }}`);
}

/**
 * `required` — Require a value to be set.
 *
 * `required("msg", values.x)` → `{{ required "msg" .Values.x }}`
 */
export function required(msg: string, val: HelmTpl): HelmTpl {
  const inner = extractExpr(val);
  return new HelmTpl(`{{ required "${msg}" ${inner} }}`);
}

/**
 * `helmDefault` — Provide a default value.
 *
 * `helmDefault("nginx", values.image.repository)` → `{{ default "nginx" .Values.image.repository }}`
 */
export function helmDefault(def: string | number | boolean, val: HelmTpl): HelmTpl {
  const inner = extractExpr(val);
  const defStr = typeof def === "string" ? `"${def}"` : String(def);
  return new HelmTpl(`{{ default ${defStr} ${inner} }}`);
}

/**
 * `toYaml` — Convert a value to YAML.
 *
 * `toYaml(values.resources)` → `{{ toYaml .Values.resources | nindent 12 }}`
 */
export function toYaml(val: HelmTpl, indent?: number): HelmTpl {
  const inner = extractExpr(val);
  if (indent !== undefined) {
    return new HelmTpl(`{{ toYaml ${inner} | nindent ${indent} }}`);
  }
  return new HelmTpl(`{{ toYaml ${inner} }}`);
}

/**
 * `quote` — Quote a value.
 *
 * `quote(values.x)` → `{{ quote .Values.x }}`
 */
export function quote(val: HelmTpl): HelmTpl {
  const inner = extractExpr(val);
  return new HelmTpl(`{{ ${inner} | quote }}`);
}

/**
 * `printf` — Format a string.
 *
 * `printf("%s:%s", values.image.repository, values.image.tag)`
 * → `{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}`
 */
export function printf(fmt: string, ...args: HelmTpl[]): HelmTpl {
  const argExprs = args.map(extractExpr).join(" ");
  return new HelmTpl(`{{ printf "${fmt}" ${argExprs} }}`);
}

/**
 * `tpl` — Evaluate a string as a template.
 *
 * `tpl(values.someTemplate)` → `{{ tpl .Values.someTemplate . }}`
 */
export function tpl(template: HelmTpl, ctx: string = "."): HelmTpl {
  const inner = extractExpr(template);
  return new HelmTpl(`{{ tpl ${inner} ${ctx} }}`);
}

/**
 * `lookup` — Look up a resource at deploy time.
 *
 * `lookup("v1", "Secret", "ns", "name")` → `{{ lookup "v1" "Secret" "ns" "name" }}`
 */
export function lookup(apiVersion: string, kind: string, namespace: string, name: string): HelmTpl {
  return new HelmTpl(`{{ lookup "${apiVersion}" "${kind}" "${namespace}" "${name}" }}`);
}

// ── Control flow ──────────────────────────────────────────

/**
 * Marker interface for conditional resource wrappers.
 */
export interface HelmConditional extends Intrinsic {
  readonly condition: string;
  readonly body: unknown;
  readonly elseBody?: unknown;
}

/**
 * `If` — Conditional resource or value.
 *
 * When used at the resource level (wrapping a Declarable), the serializer
 * wraps the entire YAML document in `{{- if }}` / `{{- end }}`.
 *
 * When used at the value level, it emits inline conditionals.
 *
 * ```ts
 * If(values.ingress.enabled, new Ingress({ ... }))
 * ```
 */
export function If(condition: HelmTpl | string, then: unknown, elseBody?: unknown): HelmConditional & { toJSON(): unknown } {
  const condExpr = typeof condition === "string" ? condition : extractExpr(condition);
  return {
    [INTRINSIC_MARKER]: true as const,
    condition: condExpr,
    body: then,
    elseBody,
    toJSON() {
      // Resolve nested ElseIf objects by calling their toJSON()
      const resolvedElse = elseBody !== undefined && typeof elseBody === "object" && elseBody !== null && "toJSON" in elseBody
        ? (elseBody as { toJSON(): unknown }).toJSON()
        : elseBody;
      return {
        [HELM_IF_KEY]: condExpr,
        body: then,
        ...(resolvedElse !== undefined ? { else: resolvedElse } : {}),
      };
    },
  };
}

/**
 * `ElseIf` — Chained else-if condition for use inside an `If` else body.
 *
 * The serializer detects when an else body contains a `__helm_if` marker
 * and emits `{{- else if <cond> }}` instead of a nested `{{- else }}\n{{- if }}`.
 *
 * ```ts
 * If(values.tier, "gold",
 *   ElseIf(values.backup, "silver", "bronze"))
 * ```
 * → `{{- if .Values.tier }}gold{{- else if .Values.backup }}silver{{- else }}bronze{{- end }}`
 */
export function ElseIf(
  condition: HelmTpl | string,
  then: unknown,
  elseBody?: unknown,
): { toJSON(): unknown } {
  const condExpr = typeof condition === "string" ? condition : extractExpr(condition);
  return {
    toJSON() {
      return {
        [HELM_IF_KEY]: condExpr,
        body: then,
        ...(elseBody !== undefined ? { else: elseBody } : {}),
      };
    },
  };
}

/**
 * `Range` — Iterate over a list at deploy time.
 *
 * ```ts
 * Range(values.hosts, (item) => ({ host: item }))
 * ```
 */
export function Range(list: HelmTpl, body: unknown): Intrinsic {
  const listExpr = extractExpr(list);
  return {
    [INTRINSIC_MARKER]: true as const,
    toJSON() {
      return {
        [HELM_RANGE_KEY]: listExpr,
        body,
      };
    },
  };
}

/**
 * `With` — Scope into a value at deploy time.
 *
 * ```ts
 * With(values.nodeSelector, (ctx) => ctx)
 * ```
 */
export function With(scope: HelmTpl, body: unknown): Intrinsic {
  const scopeExpr = extractExpr(scope);
  return {
    [INTRINSIC_MARKER]: true as const,
    toJSON() {
      return {
        [HELM_WITH_KEY]: scopeExpr,
        body,
      };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────

/**
 * Extract the Go template expression from a HelmTpl, stripping `{{ }}` wrappers.
 */
function extractExpr(val: HelmTpl | string): string {
  if (typeof val === "string") return val;
  return val.expr.replace(/^\{\{-?\s*/, "").replace(/\s*-?\}\}$/, "");
}
