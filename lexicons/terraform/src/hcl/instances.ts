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
 * variable) for `for_each`, and `toset(var.l)`. Anything else, or any value
 * that is unknown, leaves the block as one node, which is what it was. A
 * block under an expanded call whose own expansion or whose call's expansion
 * cannot be counted gets no instances at all, since a partial list would
 * name ids the plan never prints.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import { loadHcl2json, type Hcl2Json } from "@intentius/chant/terraform/hcl2json";
import {
  DATA_TYPE,
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
const VAR_RE = new RegExp(`^var\\.(${NAME})$`);
const LENGTH_RE = new RegExp(`^length\\(\\s*var\\.(${NAME})\\s*\\)$`);
const TOSET_RE = new RegExp(`^toset\\(\\s*var\\.(${NAME})\\s*\\)$`);

/** A variable's known value, and whether it is declared as a set. */
interface VarValue {
  value: unknown;
  set: boolean;
}

/** Variable name to known value, for one module scope. A name that is absent is unknown. */
type ScopeVars = Map<string, VarValue>;

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
 * Evaluate an argument in a scope: a literal, a bare `var.x`, `length(var.x)`
 * or `toset(var.x)`. Undefined when unknown.
 */
function evaluate(value: unknown, vars: ScopeVars): VarValue | undefined {
  if (typeof value !== "string" || !value.includes("${")) {
    const v = literal(value);
    return v === undefined ? undefined : { value: v, set: false };
  }
  const m = INTERPOLATION_RE.exec(value.trim());
  if (!m) return undefined;
  const inner = m[1]!;
  if (/^\d+$/.test(inner)) return { value: Number(inner), set: false };
  let r: RegExpExecArray | null;
  if ((r = VAR_RE.exec(inner))) return vars.get(r[1]!);
  if ((r = LENGTH_RE.exec(inner))) {
    const v = vars.get(r[1]!)?.value;
    if (Array.isArray(v)) return { value: v.length, set: false };
    if (typeof v === "object" && v !== null) return { value: Object.keys(v).length, set: false };
    if (typeof v === "string") return { value: [...v].length, set: false };
    return undefined;
  }
  if ((r = TOSET_RE.exec(inner))) {
    const v = vars.get(r[1]!)?.value;
    return Array.isArray(v) ? { value: v, set: true } : undefined;
  }
  return undefined;
}

/**
 * The instance keys a block's `count` or `for_each` gives in `vars`, as
 * Terraform prints them. `null` when the block is not expanded, undefined
 * when it is and the keys are not known.
 */
export function instanceKeysIn(body: BlockBody, vars: ScopeVars): string[] | null | undefined {
  if (!("count" in body) && !("for_each" in body)) return null;
  const lit = literalInstanceKeys(body);
  if (lit) return lit;
  let keys: string[] | undefined;
  if ("count" in body) {
    const v = evaluate(body.count, vars)?.value;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) keys = Array.from({ length: v }, (_, i) => `[${i}]`);
  } else {
    const v = evaluate(body.for_each, vars);
    if (v && Array.isArray(v.value)) {
      if (v.set && v.value.every((s) => typeof s === "string")) {
        keys = [...new Set(v.value as string[])].sort().map((k) => `[${JSON.stringify(k)}]`);
      }
    } else if (v && typeof v.value === "object" && v.value !== null) {
      keys = Object.keys(v.value).sort().map((k) => `[${JSON.stringify(k)}]`);
    }
  }
  return keys === undefined || keys.length > MAX_INSTANCES ? undefined : keys;
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

  const tfvars = await rootTfvars(opts);
  const scopes = new Map<string, ScopeVars>();

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
        const v = evaluate(callBody[name], parentVars);
        if (v !== undefined) vars.set(name, { value: v.value, set: set || v.set });
      } else {
        const v = literal(body.default);
        if (v !== undefined) vars.set(name, { value: v, set });
      }
    }
    return vars;
  };

  /** A module call's keys, by the call entity's key: null when not expanded, undefined when not known. */
  const callKeys = (callKey: string): string[] | null | undefined => {
    const call = entities.get(callKey) as TerraformEntity | undefined;
    if (!call || call.entityType !== MODULE_TYPE) return undefined;
    return instanceKeysIn(bodyOf(call), varsOf(scopeOfKey(callKey)));
  };

  for (const [key, entity] of own) {
    if (entity.entityType !== RESOURCE_TYPE && entity.entityType !== DATA_TYPE && entity.entityType !== MODULE_TYPE) continue;
    const callers = callersOfKey(key);
    const chain: Array<string[] | null | undefined> = callers.map((_, i) => callKeys(`${root}/${callers.slice(0, i + 1).join("/")}`));
    const ownKeys = instanceKeysIn(bodyOf(entity), varsOf(scopeOfKey(key)));
    const expandedChain = chain.some((k) => k !== null);

    if (!expandedChain) {
      if (ownKeys && !entity.instanceKeys) entities.set(key, { ...entity, instanceKeys: ownKeys } as TerraformEntity);
      continue;
    }

    // Under an expanded module call the literal `instanceKeys` would name ids
    // under the unexpanded call, which no plan prints: the listed instances
    // replace them, or nothing does.
    const { instanceKeys: _dropped, ...rest } = entity;
    if (chain.some((k) => k === undefined) || ownKeys === undefined) {
      entities.set(key, rest as TerraformEntity);
      continue;
    }
    let combos: string[][] = [[]];
    for (const keys of chain) combos = combos.flatMap((c) => (keys ?? [""]).map((k) => [...c, k]));
    const tails = ownKeys ?? [""];
    if (combos.length * tails.length > MAX_INSTANCES) {
      entities.set(key, rest as TerraformEntity);
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
