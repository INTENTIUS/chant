/**
 * Which roots a change composes, in what order, and why the others fall back
 * (chant#4438, epic #4419). Pure functions over a project's config, its
 * components and its roots' files: nothing here runs a binary.
 *
 * A composed run plans the `terraform-apply` components a change reaches,
 * and the ones they read, as one plan of a composed root of `module` calls,
 * and applies it as one apply, so a value one root creates reaches the roots
 * that read it inside that apply. Writing the composed root is #4441;
 * splitting its state is #4442; running it is #4444.
 *
 * Lifted from terragucci's `packages/terragucci/src/compose.ts` at c493e0e
 * (`Composition`, `composeSet`, `readOrder`, `moduleNames`, `compositionFor`,
 * `fallbackOf`, `fallbackLine`), with chant's inputs in place of terragucci's:
 *
 * - The roots are `terraform.roots`, each deployed by a component whose step
 *   is `{ kind: "terraform-apply", root }`. A member is a component.
 * - A read between members is a `stackOutput()` in the step's `vars`, a
 *   `terraform_remote_state` block whose address is another member's
 *   backend, or a `terraform_estate_outputs` block naming another member's
 *   estate.
 * - `waves.after` is the component's `dependsOn`; `oidc.roles` is the apply
 *   identity the caller resolves per member (`ci.identity.cloud`, #4296);
 *   `TF_CLI_ARGS*` is read from the environment as before.
 *
 * Unlike terragucci, part of a change can compose (#4419 ruling 1): each
 * member that cannot is left out with its own reason, and the rest compose
 * when two or more remain. A component of another kind, or a root left out,
 * on a dependency path between two members splits them (ruling 2), and only
 * a component whose deploy is that one step joins (ruling 3).
 *
 * Off unless `terraform.compose.enabled` is set: {@link compositionIfEnabled}
 * is the entry point, and calls nothing when it is not.
 */

import { isAbsolute, resolve } from "node:path";
import type { PipelineCloudIdentity } from "@intentius/chant/ci-identity";
import type { GroupFallback } from "@intentius/chant/components/capability";
import { wiringReads, type DriverComponent, type DriverPhase, type DriverStep } from "@intentius/chant/components/driver";
import type { TerraformConfig, TerraformRootConfig } from "./config";
import {
  backendBlock,
  estateOutputReads,
  importLiteral,
  jsonImportRefused,
  liveEstate,
  localModules,
  lockedProviders,
  relPath,
  rootState,
  rootTexts,
  sameState,
  blockBody,
  type RootState,
} from "./compose/hcl";

export { blankComments, lockedProviders, blockBody, hclAttr, backendBlock, rootState, liveEstate, estateOutputReads } from "./compose/hcl";

/** `terraform.compose.max` when unset. */
export const DEFAULT_COMPOSE_MAX = 10;

/** The step kind a member's deploy is. */
export const COMPOSE_STEP_KIND = "terraform-apply";

/**
 * Why a member, or the whole change, applies in waves. `steps` and `split`
 * are the kinds core's own group pass uses for the same reasons (ws-107);
 * `off` is what the capability answers core's `groupFallback` with when
 * `terraform.compose` is not enabled. `plan-failed` is kept for a reader of
 * terragucci's reports: under core, a group plan that throws makes every
 * member plan-failed instead (ws-107).
 */
export type ComposeFallbackKind =
  | "off"
  | "too-many-roots"
  | "one-root"
  | "binary"
  | "identity"
  | "workspace"
  | "backend"
  | "provider-lock"
  | "cli-args"
  | "read"
  | "order-only"
  | "import"
  | "path"
  | "plan-failed"
  | "targets"
  | "steps"
  | "same-root"
  | "split";

/** A fallback, in the shape of core's `GroupFallback` (ws-107) with the member it leaves out. */
export interface ComposeFallback extends GroupFallback {
  kind: ComposeFallbackKind;
  /** The member left out. Absent when the reason is the whole change's. */
  member?: string;
  /** One line, no trailing period. */
  reason: string;
}

/** One read of a member by another member. */
export type ComposedRead =
  /** A `stackOutput()` in the step's `vars`: `variable` is the top-level var it is in, `output` the upstream output. */
  | { via: "vars"; upstream: string; variable: string; output: string }
  /** A `terraform_remote_state` block, by label. */
  | { via: "remote-state"; upstream: string; name: string }
  /** A choudoufu `terraform_estate_outputs` block, by label. */
  | { via: "estate-outputs"; upstream: string; name: string };

/** What `terraform.compose` comes to for one change. */
export interface Composition {
  /** The `terraform-apply` components the change reaches plus those they read, followed upstream, sorted. */
  candidates: string[];
  /** The candidates that compose, sorted. Empty when {@link fallback} is set. */
  members: string[];
  /** The members, each after every member it reads. */
  order: string[];
  /** `terraform.compose.max`. */
  max: number;
  /** Each candidate's key in `terraform.roots`. */
  roots: Map<string, string>;
  /** Each candidate's root directory, absolute. */
  dirs: Map<string, string>;
  /** Each member's module name in the composed root: a valid HCL identifier, stable across runs. */
  modules: Map<string, string>;
  /** Each member's reads of another member, sorted. */
  reads: Map<string, ComposedRead[]>;
  /** Every member runs choudoufu against a `live` estate: one choudoufu run over estates, no state to pull, split or write back. */
  estate?: boolean;
  /** Each candidate left out and why, in member order. Those plan wave by wave as without the setting. */
  fallbacks: ComposeFallback[];
  /** Why nothing composes. */
  fallback?: ComposeFallback;
}

/** The binary a member runs, before anything is installed. */
export interface ExpectedBinary {
  name: string;
  version?: string;
}

export interface CompositionInput {
  /** The directory `chant.config.*` was loaded from; a root's `dir` resolves against it. */
  projectRoot: string;
  /** The config's `terraform` namespace. */
  terraform: TerraformConfig;
  /** Every component of the project, of every kind. */
  components: readonly DriverComponent[];
  /** The components the change reaches; undefined when every component plans. */
  selected?: ReadonlySet<string>;
  /** The environment the run has: `TF_CLI_ARGS*` is read from it. */
  env: NodeJS.ProcessEnv;
  /**
   * The apply identity a member runs under, as one comparable string
   * ({@link identityKey} of `resolveTargetCloudIdentity` for its root, #4296).
   * Members with different strings do not compose. Unset: one identity.
   */
  identity?: (member: string) => string | undefined;
  /** The targets each member is given (`--target`, #4300). */
  targets?: Readonly<Record<string, readonly string[]>>;
  /** Each member's binary. Default: `terraform.binary`, at no stated version. */
  binary?: (member: string) => ExpectedBinary;
}

/** A member's identity as {@link CompositionInput.identity} compares it: its apply trade, or `""` for none. */
export function identityKey(identity: PipelineCloudIdentity | undefined): string {
  return identity ? JSON.stringify(identity.apply) : "";
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const list = (xs: readonly string[]): string => xs.map((x) => `\`${x}\``).join(", ");

/**
 * The module name of each root: its name with every character a name cannot
 * hold as `_` (`envs/prod-app` is `envs_prod_app`), `root` for an empty one,
 * `r_` before a leading digit, and `_2`, `_3` on a clash, given in name order.
 */
export function moduleNames(roots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const r of [...new Set(roots)].sort()) {
    let base = r === "." || r === "" ? "root" : r.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "root";
    if (/^[0-9]/.test(base)) base = `r_${base}`;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
    taken.add(name);
    out.set(r, name);
  }
  return out;
}

/** The members of `set`, each after every member of the set it reads; members that read none of each other in name order. */
export function readOrder(set: readonly string[], deps: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const left = new Set(set);
  const out: string[] = [];
  while (left.size > 0) {
    const ready = [...left].filter((r) => [...(deps.get(r) ?? [])].every((u) => !left.has(u))).sort();
    // A cycle the waves would refuse: take the rest in name order rather than stop.
    const take = ready.length > 0 ? ready : [...left].sort();
    for (const r of take) {
      out.push(r);
      left.delete(r);
    }
  }
  return out;
}

/** The members a composed run covers: those of `all` the change reaches and every one of `all` they read, followed upstream. */
export function composeSet(all: readonly string[], selected: ReadonlySet<string> | undefined, deps: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const set = new Set(selected ? [...selected].filter((r) => all.includes(r)) : all);
  const queue = [...set];
  while (queue.length > 0) {
    const r = queue.pop()!;
    for (const u of deps.get(r) ?? []) {
      if (!set.has(u) && all.includes(u)) {
        set.add(u);
        queue.push(u);
      }
    }
  }
  return [...set].sort();
}

// ── components ────────────────────────────────────────────────────────────

/** Every leaf step of a deploy, gates included, in order. */
function leafSteps(phases: readonly DriverPhase[]): DriverStep[] {
  const out: DriverStep[] = [];
  const walk = (steps: DriverPhase["steps"]): void => {
    for (const s of steps) {
      if (typeof (s as DriverPhase).phase === "string" && Array.isArray((s as DriverPhase).steps)) walk((s as DriverPhase).steps);
      else out.push(s as DriverStep);
    }
  };
  for (const p of phases) walk(p.steps);
  return out;
}

/** A component that deploys a root: its first `terraform-apply` step and how many steps its deploy has. */
interface RootComponent {
  name: string;
  step: DriverStep;
  steps: number;
  root?: string;
  config?: TerraformRootConfig;
  /** Absolute. */
  dir?: string;
  /** Relative to the project. */
  rel?: string;
  state?: RootState;
  estate?: string;
  live: boolean;
}

/** A component's kind, for a reason: its first step's kind. */
const kindOf = (c: DriverComponent): string => leafSteps(c.deploy)[0]?.kind ?? "empty";

/** The top-level vars of a step and the members' outputs each reads through `stackOutput()` or `@<component>.publish.*`. */
function varsReads(step: DriverStep): { variable: string; upstream: string; output: string }[] {
  const vars = step.vars && typeof step.vars === "object" && !Array.isArray(step.vars) ? (step.vars as Record<string, unknown>) : {};
  const out: { variable: string; upstream: string; output: string }[] = [];
  for (const [variable, value] of Object.entries(vars)) {
    for (const r of wiringReads({ [variable]: value }, {})) out.push({ variable, upstream: r.source, output: r.ref.slice(r.source.length + 1) });
  }
  return out;
}

/** Every component another reads or depends on, from any step's wiring and its `dependsOn`, plus the HCL reads between roots. */
function dependencyGraph(components: readonly DriverComponent[], hcl: ReadonlyMap<string, readonly ComposedRead[]>): Map<string, Set<string>> {
  const names = new Set(components.map((c) => c.name));
  const out = new Map<string, Set<string>>();
  for (const c of components) {
    const deps = new Set((c.dependsOn ?? []).filter((d) => names.has(d)));
    for (const step of leafSteps(c.deploy)) {
      for (const r of wiringReads(step as Record<string, unknown>, {})) if (names.has(r.source) && r.source !== c.name) deps.add(r.source);
    }
    for (const r of hcl.get(c.name) ?? []) deps.add(r.upstream);
    out.set(c.name, deps);
  }
  return out;
}

/** Each root component's HCL reads of another root component. */
function hclReads(rcs: readonly RootComponent[]): Map<string, ComposedRead[]> {
  const out = new Map<string, ComposedRead[]>();
  for (const r of rcs) {
    const reads: ComposedRead[] = [];
    if (r.state && r.dir) {
      for (const read of r.state.reads) {
        for (const o of rcs) if (o.name !== r.name && o.state?.own && sameState(o.state.own, read)) reads.push({ via: "remote-state", upstream: o.name, name: read.name });
      }
      for (const read of estateOutputReads(r.dir)) {
        for (const o of rcs) if (o.name !== r.name && o.estate === read.estate) reads.push({ via: "estate-outputs", upstream: o.name, name: read.name });
      }
    }
    out.set(r.name, reads);
  }
  return out;
}

const readKey = (r: ComposedRead): string => `${r.upstream}\0${r.via}\0${r.via === "vars" ? `${r.variable}\0${r.output}` : r.name}`;

// ── the composition ───────────────────────────────────────────────────────

/** `TF_CLI_ARGS*` flags a composed run cannot take: their addresses name a root's resources without the module in front, and `-var` names no root. */
const CLI_REFUSED = /(^|\s)-{1,2}(target|exclude|replace|var)(=|\s|$)/;

/** The backend types whose lock chant takes itself (#4437). */
const LOCKED_BACKENDS = ["s3", "gcs", "azurerm", "local"];

/**
 * The `off` fallback when `terraform.compose` is not enabled, else undefined:
 * what `terraform-apply`'s `groupFallback` answers first (ws-107).
 */
export function composeOff(terraform: TerraformConfig): ComposeFallback | undefined {
  return terraform.compose?.enabled === true ? undefined : { kind: "off", reason: "`terraform.compose` is not enabled" };
}

/**
 * The composition when `terraform.compose.enabled` is set, else undefined
 * without reading anything. The only caller of {@link compositionFor} a run
 * should use.
 */
export function compositionIfEnabled(input: CompositionInput): Composition | undefined {
  if (input.terraform.compose?.enabled !== true) return undefined;
  return compositionFor(input);
}

/**
 * What `terraform.compose` comes to for a change: the members, their order,
 * modules and reads, each candidate left out with its reason, or why nothing
 * composes. Per-member checks run first (root, steps, targets, binary,
 * backend, identity, provider lock, reads, imports and paths, order, split);
 * a member left out gets the first that applies to it. `cli-args`,
 * `too-many-roots` and `one-root` then judge what is left as a whole.
 */
export function compositionFor(input: CompositionInput): Composition {
  const tf = input.terraform;
  const max = tf.compose?.max ?? DEFAULT_COMPOSE_MAX;
  const projectRoot = resolve(input.projectRoot);
  const byName = new Map(input.components.map((c) => [c.name, c]));

  // Every component that deploys a root, read once.
  const rcs: RootComponent[] = [];
  for (const c of input.components) {
    const steps = leafSteps(c.deploy);
    const step = steps.find((s) => s.kind === COMPOSE_STEP_KIND);
    if (!step) continue;
    const root = typeof step.root === "string" ? step.root : undefined;
    const config = root !== undefined ? tf.roots[root] : undefined;
    const rc: RootComponent = { name: c.name, step, steps: steps.length, live: false, ...(root !== undefined ? { root } : {}) };
    if (config && step.cwd === undefined) {
      const dir = isAbsolute(config.dir) ? config.dir : resolve(projectRoot, config.dir);
      const rel = relPath(projectRoot, dir);
      const live = liveEstate(dir);
      const estate = config.estate ?? live.estate;
      Object.assign(rc, { config, dir, rel, state: rootState(dir, rel, config.backendConfig), live: live.live, ...(estate ? { estate } : {}) });
    }
    rcs.push(rc);
  }
  const rcOf = new Map(rcs.map((r) => [r.name, r]));
  const hcl = hclReads(rcs);
  const graph = dependencyGraph(input.components, hcl);
  const candidates = composeSet(
    rcs.map((r) => r.name),
    input.selected,
    graph,
  );

  const roots = new Map(candidates.flatMap((m) => (rcOf.get(m)!.root !== undefined ? [[m, rcOf.get(m)!.root!] as const] : [])));
  const dirs = new Map(candidates.flatMap((m) => (rcOf.get(m)!.dir ? [[m, rcOf.get(m)!.dir!] as const] : [])));

  // Each member's reads of every other candidate; narrowed to members at the end.
  const allReads = new Map<string, ComposedRead[]>();
  for (const m of candidates) {
    const rc = rcOf.get(m)!;
    const reads: ComposedRead[] = [...varsReads(rc.step).map((r) => ({ via: "vars" as const, ...r })), ...(hcl.get(m) ?? [])];
    allReads.set(m, reads.filter((r) => r.upstream !== m && rcOf.has(r.upstream)));
  }

  const left = new Map<string, ComposeFallback>();
  let members = [...candidates];
  const drop = (m: string, kind: ComposeFallbackKind, reason: string): void => {
    left.set(m, { kind, member: m, reason });
    members = members.filter((x) => x !== m);
  };
  const each = (check: (m: string, rc: RootComponent) => [ComposeFallbackKind, string] | undefined): void => {
    for (const m of [...members]) {
      const hit = check(m, rcOf.get(m)!);
      if (hit) drop(m, hit[0], hit[1]);
    }
  };

  // Where the root is, and that its deploy is that one step.
  each((m, rc) => {
    if (rc.root === undefined) return ["path", `\`${m}\`'s terraform-apply step names no \`root\``];
    if (rc.step.cwd !== undefined) return ["path", `\`${m}\`'s terraform-apply step sets \`cwd\`, so its root is read from another chant.config`];
    if (!rc.config) return ["path", `\`${m}\` deploys root \`${rc.root}\`, which \`terraform.roots\` does not list`];
    return undefined;
  });
  const rootTaken = new Map<string, string>();
  each((m, rc) => {
    const had = rootTaken.get(rc.root!);
    if (had) return ["same-root", `\`${m}\` deploys root \`${rc.root}\`, which \`${had}\` deploys too, and a composed run calls each root once`];
    rootTaken.set(rc.root!, m);
    return undefined;
  });
  each((m, rc) =>
    rc.steps !== 1 ? ["steps", `\`${m}\`'s deploy has ${plural(rc.steps, "step")}, and only a component whose deploy is one terraform-apply step composes`] : undefined,
  );
  each((m) => {
    const t = input.targets?.[m] ?? [];
    return t.length > 0 ? ["targets", `\`${m}\` is given ${plural(t.length, "target")} (\`--target\`), and a composed run plans each member whole`] : undefined;
  });

  // One binary process: one binary at one version.
  const binaryOf = (m: string): ExpectedBinary => input.binary?.(m) ?? { name: tf.binary ?? "terraform" };
  const binName = (b: ExpectedBinary): string => `${b.name}${b.version ? ` ${b.version}` : ""}`;
  const binRef = majority(members, (m) => binName(binaryOf(m)));
  each((m) => {
    if (!binRef || binName(binaryOf(m)) === binRef.key) return undefined;
    return ["binary", `\`${m}\` runs ${binName(binaryOf(m))} and \`${binRef.first}\` ${binRef.key}, and one run has one binary`];
  });

  // Every member runs choudoufu and one has a `live` block: the members compose as estates (choudoufu#2059).
  const estate = members.length > 1 && members.every((m) => binaryOf(m).name === "choudoufu") && members.some((m) => rcOf.get(m)!.live);
  each((m, rc) => {
    if (estate) return rc.live ? undefined : ["backend", `\`${m}\` has no \`live\` block, and a composed run of estates calls only directories that carry one`];
    const ws = rc.config!.workspace;
    if (ws && ws !== "default") return ["workspace", `\`${m}\` plans in workspace ${ws}, and a composed run plans in default`];
    const b = backendBlock(rc.dir!);
    if (b && "cloud" in b) return ["backend", `\`${m}\` has a \`cloud\` block, whose state chant does not lock itself`];
    const type = b?.type ?? "local";
    if (!LOCKED_BACKENDS.includes(type)) return ["backend", `\`${m}\`'s backend is ${type}, and chant locks only s3 (with use_lockfile), gcs, azurerm and local states itself`];
    if (type === "s3") {
      const initArgs = `${input.env.TF_CLI_ARGS ?? ""} ${input.env.TF_CLI_ARGS_init ?? ""}`;
      const said =
        rootTexts(rc.dir!).some((t) => /\buse_lockfile\s*=\s*true\b/.test(t.text) || /"use_lockfile"\s*:\s*true/.test(t.text)) ||
        rc.config!.backendConfig?.use_lockfile === "true" ||
        /use_lockfile=true/.test(initArgs);
      if (!said) return ["backend", `\`${m}\`'s s3 backend takes no lock file (\`use_lockfile = true\`), so chant cannot hold its lock`];
    }
    return undefined;
  });

  // One binary process has one set of credentials. Estates take each one's role from its own provider blocks.
  if (!estate && input.identity) {
    const idOf = (m: string): string => input.identity!(m) ?? "";
    const idRef = majority(members, idOf);
    each((m) => {
      if (!idRef || idOf(m) === idRef.key) return undefined;
      const same = members.filter((x) => idOf(x) === idRef.key);
      return ["identity", `\`${m}\` applies under another cloud identity (\`ci.identity.cloud\`) than ${list(same)}, and one run has one set of credentials`];
    });
  }

  // One run installs one version of each provider: the first member in name order to lock it sets it.
  const locked = new Map<string, { version: string; member: string }>();
  each((m, rc) => {
    const mine = lockedProviders(rc.dir!);
    for (const [p, v] of mine) {
      const had = locked.get(p);
      if (had && had.version !== v) return ["provider-lock", `\`${m}\` locks ${p} at ${v} and \`${had.member}\` at ${had.version}, and one run installs one version`];
    }
    for (const [p, v] of mine) if (!locked.has(p)) locked.set(p, { version: v, member: m });
    return undefined;
  });

  // Reads a composed root cannot rewrite.
  each((m, rc) => {
    for (const r of allReads.get(m) ?? []) {
      if (r.via !== "remote-state" || !members.includes(r.upstream)) continue;
      if (rc.state!.reads.find((x) => x.name === r.name)?.repeated) {
        return ["read", `\`${m}\` reads \`${r.upstream}\` through a block with count or for_each (\`data.terraform_remote_state.${r.name}\`)`];
      }
    }
    for (const mod of localModules(rc.dir!)) {
      const modRel = relPath(projectRoot, mod);
      for (const read of rootState(mod, modRel).reads) {
        const up = members.find((o) => o !== m && rcOf.get(o)!.state?.own && sameState(rcOf.get(o)!.state!.own!, read));
        if (up) return ["read", `\`${m}\` reads \`${up}\` from its module \`${modRel}\`, and a composed run rewrites only a root's own reads`];
      }
    }
    return undefined;
  });

  // What a module call cannot carry.
  each((m, rc) => {
    for (const t of rootTexts(rc.dir!)) {
      if (t.json) {
        if (jsonImportRefused(t.text)) return ["import", `an \`import\` block of \`${m}\` takes no literal string \`id\`, so it cannot be lifted into the composed root`];
        continue;
      }
      for (const im of t.text.matchAll(/(^|\n)\s*import\s*\{/g)) {
        if (!importLiteral(blockBody(t.text, im.index! + im[1]!.length))) {
          return ["import", `an \`import\` block of \`${m}\` takes no literal string \`id\`, so it cannot be lifted into the composed root`];
        }
      }
      if (/\bpath\.(root|cwd)\b/.test(t.text)) return ["path", `\`${m}\` uses \`path.root\` or \`path.cwd\`, which would name the composed root instead of \`${rc.rel}\``];
    }
    return undefined;
  });

  // An order with no read: a module with its own providers takes no depends_on.
  each((m) => {
    const reads = new Set((allReads.get(m) ?? []).map((r) => r.upstream));
    const u = (byName.get(m)?.dependsOn ?? []).find((d) => members.includes(d) && !reads.has(d));
    return u ? ["order-only", `\`${m}\` depends on \`${u}\` (\`dependsOn\`) with no read between them, and a module with its own providers takes no depends_on`] : undefined;
  });

  // A component outside the run on a path between two members splits them (#4419 ruling 2): the one after it leaves.
  for (let moved = true; moved; ) {
    moved = false;
    for (const m of [...members]) {
      const hit = pathOutside(m, members, graph);
      if (!hit) continue;
      const via = byName.get(hit.via);
      const what = rcOf.has(hit.via) ? "which is left out of the composed run and applies between them" : `a ${via ? kindOf(via) : "other"} component that applies between them`;
      drop(m, "split", `\`${m}\` depends on \`${hit.member}\` through \`${hit.via}\`, ${what}`);
      moved = true;
      break;
    }
  }

  const fallbacks = candidates.flatMap((m) => (left.has(m) ? [left.get(m)!] : []));
  const base = { candidates, max, roots, dirs, fallbacks };
  const none = (fallback: ComposeFallback): Composition => ({ ...base, members: [], order: [], modules: new Map(), reads: new Map(), fallback });

  if (members.length >= 2) {
    for (const k of ["TF_CLI_ARGS", "TF_CLI_ARGS_plan", "TF_CLI_ARGS_apply"]) {
      const cli = (input.env[k] ?? "").match(CLI_REFUSED);
      if (cli) return none({ kind: "cli-args", reason: `\`${k}\` carries \`-${cli[2]}\`, which names a root's own addresses or variables, not the composed run's` });
    }
  }
  if (members.length > max) return none({ kind: "too-many-roots", reason: `this change composes ${plural(members.length, "root")}, more than \`terraform.compose.max\` (${max})` });
  if (members.length <= 1) {
    if (candidates.length === 0) return none({ kind: "one-root", reason: "this change reaches no root" });
    if (candidates.length === 1) return none({ kind: "one-root", member: candidates[0]!, reason: `this change reaches one root, \`${candidates[0]}\`, which applies in its own run` });
    return none({
      kind: "one-root",
      ...(members[0] ? { member: members[0] } : {}),
      reason: members.length === 0 ? "no root of this change can compose" : `only \`${members[0]}\` of this change can compose, and one root applies in its own run`,
    });
  }

  const inGroup = new Map(members.map((m) => [m, new Set([...(graph.get(m) ?? [])].filter((u) => members.includes(u)))] as const));
  const order = readOrder(members, inGroup);
  const names = moduleNames(members.map((m) => roots.get(m)!));
  const modules = new Map(members.map((m) => [m, names.get(roots.get(m)!)!] as const));
  const reads = new Map(
    members.map((m) => {
      const seen = new Map<string, ComposedRead>();
      for (const r of allReads.get(m) ?? []) if (members.includes(r.upstream)) seen.set(readKey(r), r);
      return [m, [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r)] as const;
    }),
  );
  return { ...base, members, order, modules, reads, ...(estate ? { estate } : {}) };
}

/** The value most members share, and the first member in name order that has it; a tie goes to the value the earliest member has. */
function majority(members: readonly string[], key: (m: string) => string): { key: string; first: string } | undefined {
  const groups = new Map<string, string[]>();
  for (const m of [...members].sort()) groups.set(key(m), [...(groups.get(key(m)) ?? []), m]);
  let best: { key: string; first: string; n: number } | undefined;
  for (const [k, ms] of groups) if (!best || ms.length > best.n) best = { key: k, first: ms[0]!, n: ms.length };
  return best ? { key: best.key, first: best.first } : undefined;
}

/**
 * A member that `m` depends on through a component that is not a member,
 * and the first such component on the way, or undefined. Paths through
 * another member stop there: that member is checked on its own.
 */
function pathOutside(m: string, members: readonly string[], graph: ReadonlyMap<string, ReadonlySet<string>>): { member: string; via: string } | undefined {
  const seen = new Set<string>();
  const stack: { at: string; via?: string }[] = [...(graph.get(m) ?? [])].sort().map((at) => ({ at }));
  while (stack.length > 0) {
    const { at, via } = stack.shift()!;
    const key = `${at}\0${via ?? ""}`;
    if (seen.has(key) || at === m) continue;
    seen.add(key);
    if (members.includes(at)) {
      if (via) return { member: at, via };
      continue;
    }
    for (const u of [...(graph.get(at) ?? [])].sort()) stack.push({ at: u, via: via ?? at });
  }
  return undefined;
}

/** The composition with its plan failed: nothing composes, and each member plans wave by wave. */
export function withPlanFailed(c: Composition, message: string): Composition {
  const first = message.trim().split("\n")[0] ?? "";
  return { ...c, members: [], order: [], modules: new Map(), reads: new Map(), fallback: { kind: "plan-failed", reason: `the composed plan failed${first ? `: ${first}` : ""}` } };
}

/** The one line a note, a log and the report say for a fallback: the whole change's, or one member's. */
export function fallbackLine(f: ComposeFallback): string {
  return f.member !== undefined && f.kind !== "one-root"
    ? `**\`${f.member}\` applies in waves** (\`terraform.compose\`): ${f.reason}.`
    : `**Applies in waves** (\`terraform.compose\`): ${f.reason}.`;
}
