/**
 * Instance nodes the declared graph can count from variables, and instance
 * nodes under expanded module calls (chant #4486).
 *
 * `./parse.ts` gives a block its `instanceKeys` when its `count` or
 * `for_each` is a literal (#4454). This pass runs once a root and its child
 * modules are parsed and adds two cases that need the whole root:
 *
 * - An expansion that reads a variable, `count = var.n`, gets its keys when
 *   the variable's value is known from the files a plan would read: the
 *   `variable` block's `default`, then `terraform.tfvars`,
 *   `terraform.tfvars.json`, `*.auto.tfvars(.json)` in filename order, then
 *   `terraform.roots.<name>.varFiles`, later over earlier. In a child module
 *   the value is the call's argument, when it is a literal or a `var.x`
 *   known in the caller, else the child variable's default when the call
 *   passes nothing. `TF_CLI_ARGS` is not read, so the declared graph does not
 *   change with the environment the build runs in.
 * - A block under a module call that is itself expanded gets one instance
 *   per module instance (times its own instances), with the module key on
 *   the call's segment: `estate/module.app[0]/aws_eip.pool[1]`. The entity
 *   lists those as `instances` (full ids), which core's `withInstanceNodes`
 *   reads in place of `instanceKeys` (`@intentius/chant/instance-nodes`
 *   holds the id rule). A module call with a countable expansion gets
 *   instance nodes of its own, `estate/module.app[0]`.
 *
 * The forms read are `var.n`, `length(var.x)`, `var.m` (a map, or a set
 * variable) for `for_each`, and `toset(var.l)`; since #4489 the same with
 * `local.<x>` in place of `var.<x>`, where the local's value is a literal or
 * one of the `var` forms in its scope, and `var.on ? 1 : 0` (any two whole
 * numbers, and `local.on` too) over a known bool. Anything else, or any
 * value that is unknown, leaves the block as one node, which is what it
 * was, and the entity gets an `instanceRollup` saying why (#4489, the codes
 * in `@intentius/chant/instance-nodes`). `each.value` and `merge()` stay
 * rolled up by ruling. A block under an expanded call whose own expansion
 * or whose call's expansion cannot be counted gets no instances at all,
 * since a partial list would name ids the plan never prints.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import type { InstanceRollup, InstanceRollupCode } from "@intentius/chant/instance-nodes";
import { loadHcl2json, type Hcl2Json } from "@intentius/chant/terraform/hcl2json";
import {
  DATA_TYPE,
  LOCALS_TYPE,
  MODULE_TYPE,
  RESOURCE_TYPE,
  VARIABLE_TYPE,
  callersOfKey,
  literalInstanceKeys,
  scopeOfKey,
  type BlockBody,
  type TerraformEntity,
} from "./parse";

/** The most instance nodes one block gets; past it the block draws alone. */
const MAX_INSTANCES = 256;

const NAME = "[A-Za-z_][A-Za-z0-9_-]*";
const INTERPOLATION_RE = /^\$\{\s*([\s\S]*?)\s*\}$/;
/** `var.<x>` or `local.<x>` (#4489): the kind and the name. */
const REF = `(var|local)\\.(${NAME})`;
const REF_RE = new RegExp(`^${REF}$`);
const LENGTH_RE = new RegExp(`^length\\(\\s*${REF}\\s*\\)$`);
const TOSET_RE = new RegExp(`^toset\\(\\s*${REF}\\s*\\)$`);
/** `var.on ? 1 : 0` (#4489): a bool reference choosing between two whole numbers. */
const COND_RE = new RegExp(`^${REF}\\s*\\?\\s*(\\d+)\\s*:\\s*(\\d+)$`);
const EACH_RE = /\beach\.(?:value|key)\b/;
const MERGE_RE = /\bmerge\s*\(/;

/** A variable's known value, and whether it is declared as a set. */
interface VarValue {
  value: unknown;
  set: boolean;
}

/** Variable name to known value, for one module scope. A name that is absent is unknown. */
type ScopeVars = Map<string, VarValue>;

/** A scope's known `var` and `local` values (#4489). */
interface Scope {
  vars: ScopeVars;
  locals: ScopeVars;
}

const NO_LOCALS: ScopeVars = new Map();

/** An instance node an entity lists: full id, its own key and its scope, as core's `entityInstances` reads them. */
interface ListedInstance {
  id: string;
  key?: string;
  scope?: string;
}

export interface ResolveInstancesOptions {
  /** The root's directory, where its tfvars files sit. */
  dir: string;
  /** `terraform.roots.<name>.varFiles`, relative to `dir`. */
  varFiles?: readonly string[];
  hcl2json?: Hcl2Json;
}

/** Whether a value still holds an expression a read of the files cannot evaluate. */
function holdsExpression(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some(holdsExpression);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([k, v]) => k.includes("${") || holdsExpression(v));
  }
  return false;
}

/** A literal value as it stands, or undefined when it holds an expression. */
function literal(value: unknown): unknown {
  return value === undefined || holdsExpression(value) ? undefined : value;
}

/**
 * Evaluate an argument in a scope: a literal, a bare `var.x` or `local.x`,
 * `length(...)` or `toset(...)` of one, or `var.on ? 1 : 0`. Undefined when
 * unknown.
 */
function evaluate(value: unknown, vars: ScopeVars, locals: ScopeVars = NO_LOCALS): VarValue | undefined {
  if (typeof value !== "string" || !value.includes("${")) {
    const v = literal(value);
    return v === undefined ? undefined : { value: v, set: false };
  }
  const m = INTERPOLATION_RE.exec(value.trim());
  if (!m) return undefined;
  const inner = m[1]!;
  if (/^\d+$/.test(inner)) return { value: Number(inner), set: false };
  const ref = (kind: string, name: string): VarValue | undefined => (kind === "var" ? vars : locals).get(name);
  let r: RegExpExecArray | null;
  if ((r = REF_RE.exec(inner))) return ref(r[1]!, r[2]!);
  if ((r = COND_RE.exec(inner))) {
    const on = ref(r[1]!, r[2]!)?.value;
    return typeof on === "boolean" ? { value: Number(on ? r[3] : r[4]), set: false } : undefined;
  }
  if ((r = LENGTH_RE.exec(inner))) {
    const v = ref(r[1]!, r[2]!)?.value;
    if (Array.isArray(v)) return { value: v.length, set: false };
    if (typeof v === "object" && v !== null) return { value: Object.keys(v).length, set: false };
    if (typeof v === "string") return { value: [...v].length, set: false };
    return undefined;
  }
  if ((r = TOSET_RE.exec(inner))) {
    const v = ref(r[1]!, r[2]!)?.value;
    return Array.isArray(v) ? { value: v, set: true } : undefined;
  }
  return undefined;
}

/** The expression a `count` or `for_each` holds, as written, without the `${ }` around it. */
function expressionText(value: unknown): string {
  if (typeof value === "string") return (INTERPOLATION_RE.exec(value.trim())?.[1] ?? value).trim();
  return JSON.stringify(value) ?? String(value);
}

/** Why an expansion the graph could not count stays rolled up (#4489). */
function rollupCodeOf(value: unknown): InstanceRollupCode {
  if (typeof value !== "string" || !value.includes("${")) return "instances-value-unknown";
  const text = expressionText(value);
  if (EACH_RE.test(text)) return "instances-each-value";
  if (MERGE_RE.test(text)) return "instances-merge";
  const m = INTERPOLATION_RE.exec(value.trim());
  if (m && [/^\d+$/, REF_RE, LENGTH_RE, TOSET_RE, COND_RE].some((re) => re.test(m[1]!))) return "instances-value-unknown";
  return "instances-form-unread";
}

/**
 * A block's expansion in a scope: its instance keys as Terraform prints them,
 * `null` when the block is not expanded, or why the keys are not known.
 */
export function expansionIn(body: BlockBody, scope: Scope): { keys: string[] } | { rollup: InstanceRollup } | null {
  if (!("count" in body) && !("for_each" in body)) return null;
  const argument = "count" in body ? "count" : "for_each";
  const expr = body[argument];
  const rolled = (code: InstanceRollupCode): { rollup: InstanceRollup } => ({ rollup: { code, argument, expression: expressionText(expr) } });
  const lit = literalInstanceKeys(body);
  if (lit) return { keys: lit };
  let keys: string[] | undefined;
  if (argument === "count") {
    const v = evaluate(expr, scope.vars, scope.locals)?.value;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) keys = Array.from({ length: v }, (_, i) => `[${i}]`);
  } else {
    const v = evaluate(expr, scope.vars, scope.locals);
    if (v && Array.isArray(v.value)) {
      if (v.set && v.value.every((s) => typeof s === "string")) {
        keys = [...new Set(v.value as string[])].sort().map((k) => `[${JSON.stringify(k)}]`);
      }
    } else if (v && typeof v.value === "object" && v.value !== null) {
      keys = Object.keys(v.value).sort().map((k) => `[${JSON.stringify(k)}]`);
    }
  }
  if (keys === undefined) return rolled(rollupCodeOf(expr));
  if (keys.length > MAX_INSTANCES) return rolled("instances-over-limit");
  return { keys };
}

/**
 * The instance keys a block's `count` or `for_each` gives in `vars`, as
 * Terraform prints them. `null` when the block is not expanded, undefined
 * when it is and the keys are not known.
 */
export function instanceKeysIn(body: BlockBody, vars: ScopeVars, locals: ScopeVars = NO_LOCALS): string[] | null | undefined {
  const e = expansionIn(body, { vars, locals });
  return e === null ? null : "keys" in e ? e.keys : undefined;
}

/** A root's tfvars files, in the order a plan reads them, later over earlier. */
function tfvarsFiles(dir: string, varFiles: readonly string[]): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
  } catch {
    return [...varFiles];
  }
  return [
    ...["terraform.tfvars", "terraform.tfvars.json"].filter((n) => names.includes(n)),
    ...names.filter((n) => n.endsWith(".auto.tfvars") || n.endsWith(".auto.tfvars.json")).sort(),
    ...varFiles,
  ];
}

/** The values a root's tfvars files set, by variable name. A file that cannot be read or parsed sets nothing. */
async function rootTfvars(opts: ResolveInstancesOptions): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  let parser: Hcl2Json | undefined = opts.hcl2json;
  for (const file of tfvarsFiles(opts.dir, opts.varFiles ?? [])) {
    let text: string;
    try {
      text = readFileSync(resolve(opts.dir, file), "utf-8");
    } catch {
      continue;
    }
    let tree: Record<string, unknown>;
    try {
      if (file.endsWith(".json")) tree = JSON.parse(text) as Record<string, unknown>;
      else {
        parser ??= await loadHcl2json();
        tree = (await parser.parse(file, text)) as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(tree)) out.set(k, v);
  }
  return out;
}

function bodyOf(entity: TerraformEntity): BlockBody {
  const body = (entity.props as Partial<TerraformEntity["props"]>).body;
  return (typeof body === "object" && body !== null ? body : {}) as BlockBody;
}

function isSetType(body: BlockBody): boolean {
  return typeof body.type === "string" && /^\$\{\s*set\(/.test(body.type);
}

/**
 * Add instance nodes the declared graph can count to one root's entities, in
 * place (#4486). Entities of other roots in the map are left alone.
 */
export async function resolveInstanceNodes(
  entities: Map<string, Declarable>,
  root: string,
  opts: ResolveInstancesOptions,
): Promise<void> {
  const own = [...entities].filter(
    ([key, e]) => (key === root || key.startsWith(`${root}/`)) && isResourceDeclarable(e),
  ) as Array<[string, TerraformEntity]>;
  if (own.length === 0) return;

  // Variable declarations per scope.
  const declared = new Map<string, Map<string, TerraformEntity>>();
  for (const [key, e] of own) {
    if (e.entityType !== VARIABLE_TYPE) continue;
    const address = e.props.address;
    if (!address.startsWith("var.")) continue;
    const scope = scopeOfKey(key);
    (declared.get(scope) ?? declared.set(scope, new Map()).get(scope)!).set(address.slice(4), e);
  }

  // Local values per scope (#4489): every `locals` block's names.
  const localBodies = new Map<string, Map<string, unknown>>();
  for (const [key, e] of own) {
    if (e.entityType !== LOCALS_TYPE) continue;
    const scope = scopeOfKey(key);
    const into = localBodies.get(scope) ?? localBodies.set(scope, new Map()).get(scope)!;
    for (const [name, value] of Object.entries(bodyOf(e))) into.set(name, value);
  }

  const tfvars = await rootTfvars(opts);
  const scopes = new Map<string, ScopeVars>();
  const localScopes = new Map<string, ScopeVars>();

  /**
   * A scope's known local values: a literal, or a `var` form over the
   * scope's variables. A local that reads another local is unknown.
   */
  const localsOf = (scope: string): ScopeVars => {
    const cached = localScopes.get(scope);
    if (cached) return cached;
    const out: ScopeVars = new Map();
    localScopes.set(scope, out);
    for (const [name, value] of localBodies.get(scope) ?? []) {
      const v = evaluate(value, varsOf(scope));
      if (v !== undefined) out.set(name, v);
    }
    return out;
  };
  const scopeOf = (scope: string): Scope => ({ vars: varsOf(scope), locals: localsOf(scope) });

  /** A scope's known variable values, computed once, outermost first. */
  const varsOf = (scope: string): ScopeVars => {
    const cached = scopes.get(scope);
    if (cached) return cached;
    const vars: ScopeVars = new Map();
    scopes.set(scope, vars);
    const decls = declared.get(scope) ?? new Map<string, TerraformEntity>();
    if (scope === root) {
      for (const [name, decl] of decls) {
        const body = bodyOf(decl);
        const set = isSetType(body);
        const v = tfvars.has(name) ? literal(tfvars.get(name)) : literal(body.default);
        if (v !== undefined) vars.set(name, { value: v, set });
      }
      return vars;
    }
    const call = entities.get(scope) as TerraformEntity | undefined;
    const parent = scopeOfKey(scope);
    const callBody = call ? bodyOf(call) : {};
    const parentVars = varsOf(parent);
    for (const [name, decl] of decls) {
      const body = bodyOf(decl);
      const set = isSetType(body);
      if (name in callBody) {
        const v = evaluate(callBody[name], parentVars, localsOf(parent));
        if (v !== undefined) vars.set(name, { value: v.value, set: set || v.set });
      } else {
        const v = literal(body.default);
        if (v !== undefined) vars.set(name, { value: v, set });
      }
    }
    return vars;
  };

  /** A module call's expansion, by the call entity's key; a call that is not a module call is not known. */
  const callExpansion = (callKey: string): ReturnType<typeof expansionIn> | undefined => {
    const call = entities.get(callKey) as TerraformEntity | undefined;
    if (!call || call.entityType !== MODULE_TYPE) return undefined;
    return expansionIn(bodyOf(call), scopeOf(scopeOfKey(callKey)));
  };
  const keysOf = (e: ReturnType<typeof expansionIn> | undefined): string[] | null | undefined =>
    e === undefined ? undefined : e === null ? null : "keys" in e ? e.keys : undefined;

  for (const [key, entity] of own) {
    if (entity.entityType !== RESOURCE_TYPE && entity.entityType !== DATA_TYPE && entity.entityType !== MODULE_TYPE) continue;
    const callers = callersOfKey(key);
    const calls = callers.map((_, i) => callExpansion(`${root}/${callers.slice(0, i + 1).join("/")}`));
    const chain: Array<string[] | null | undefined> = calls.map(keysOf);
    const own = expansionIn(bodyOf(entity), scopeOf(scopeOfKey(key)));
    const ownKeys = keysOf(own);
    const ownRollup = own !== null && "rollup" in own ? own.rollup : undefined;
    const expandedChain = chain.some((k) => k !== null);

    if (!expandedChain) {
      if (ownKeys && !entity.instanceKeys) entities.set(key, { ...entity, instanceKeys: ownKeys } as TerraformEntity);
      else if (ownRollup) entities.set(key, { ...entity, instanceRollup: ownRollup } as TerraformEntity);
      continue;
    }

    // Under an expanded module call the literal `instanceKeys` would name ids
    // under the unexpanded call, which no plan prints: the listed instances
    // replace them, or nothing does.
    const { instanceKeys: _dropped, ...rest } = entity;
    if (chain.some((k) => k === undefined) || ownKeys === undefined) {
      // The block's own reason first, else the first call on the way that could not be counted.
      const at = chain.findIndex((k) => k === undefined);
      const callRollup = at === -1 ? undefined : calls[at];
      const rollup: InstanceRollup | undefined = ownRollup
        ?? (callRollup && "rollup" in callRollup
          ? { ...callRollup.rollup, code: "instances-module-uncounted", call: callers.slice(0, at + 1).join(".") }
          : undefined);
      entities.set(key, (rollup ? { ...rest, instanceRollup: rollup } : rest) as TerraformEntity);
      continue;
    }
    let combos: string[][] = [[]];
    for (const keys of chain) combos = combos.flatMap((c) => (keys ?? [""]).map((k) => [...c, k]));
    const tails = ownKeys ?? [""];
    if (combos.length * tails.length > MAX_INSTANCES) {
      // Named on the block's own expansion, or on the first expanded call when the block has none.
      const body = bodyOf(entity);
      const at = chain.findIndex((k) => k !== null);
      const on = ownKeys !== null || at === -1 ? body : bodyOf(entities.get(`${root}/${callers.slice(0, at + 1).join("/")}`) as TerraformEntity);
      const argument = "count" in on ? "count" : "for_each";
      const rollup: InstanceRollup = {
        code: "instances-over-limit",
        argument,
        expression: expressionText(on[argument]),
        ...(on === body ? {} : { call: callers.slice(0, at + 1).join(".") }),
      };
      entities.set(key, { ...rest, instanceRollup: rollup } as TerraformEntity);
      continue;
    }
    const address = entity.props.address;
    const instances: ListedInstance[] = [];
    for (const combo of combos) {
      const segments = callers.map((c, i) => `${c}${combo[i]}`);
      const scope = segments.join(".");
      for (const tail of tails) {
        instances.push({
          id: `${root}/${segments.join("/")}/${address}${tail}`,
          ...(tail ? { key: tail } : {}),
          scope,
        });
      }
    }
    entities.set(key, { ...rest, instances } as TerraformEntity);
  }
}
