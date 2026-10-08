/**
 * A steward's declaration (#2731): the one writer for an environment, as data
 * core can read without any lexicon loaded.
 *
 * A steward runs a fixed list of Ops, each on its own `schedule` when it has
 * one, one Op at a time. Where it runs is its form:
 *
 * - `fountain`: the fountain lexicon's `Steward` composite, an `acp` Agent on
 *   a persistent sandbox bound to a Teammate, with a Fountain `Schedule` per
 *   scheduled Op. A turn is one `chant run <op>` on the teammate's thread.
 * - `local`: `chant operator --steward <name>` in the box itself, for a box
 *   with no Fountain behind it (a docker compose box, a Sprites box). The same
 *   Ops on the same crons, each run under its operator lease, and the steward
 *   itself under a lease of its own so a second local operator is refused.
 *
 * One declaration covers both. `form` is either one of the two, or a default
 * with per-environment exceptions, so a box whose `minimal` environment has no
 * Fountain and whose `fountain-k3d` one does still has exactly one steward:
 *
 * ```ts
 * // ops/steward.op.ts
 * export const steward = declareSteward({
 *   name: "box-steward",
 *   ops: [converge, dispatch, release, upgrade],
 *   form: { default: "local", environments: { "fountain-k3d": "fountain" } },
 * });
 * ```
 *
 * The fountain composite builds this same declaration from its own options and
 * returns it as `declaration`, so a project that declares its steward there
 * exports that object from an `*.op.ts` file instead of calling this function.
 *
 * ## Discovery
 *
 * A steward is discovered from the same `*.op.ts` files Ops are
 * (`./discover.ts`), because it is chant's own run-time declaration and sits
 * beside the Ops it runs. It is plain data with a `kind` marker, not a
 * Declarable, so `chant build` never serializes it and a copy of core linked
 * twice still recognises it.
 *
 * ## What a steward writes
 *
 * A steward's writes are chant writes: run, converge and gate records on the
 * `chant/lifecycle` branch, the answer records of the decision points its
 * Ops ask (`_answers/`, #2786), and lease refs under `refs/chant/lease/`, all made
 * with git plumbing (`../lifecycle/git.ts`: `hash-object`, `mktree`,
 * `commit-tree`, `update-ref`). None of them reads or writes the checkout's
 * index or working tree, so a coding agent editing the app in the same
 * checkout, and holding git's index lock while it commits, never collides with
 * a steward turn. The app's files are the coding agent's; the steward does not
 * edit them.
 *
 * An Op that has to change the checkout (applying a build, a workspace
 * upgrade) says so with `changesCheckout` and runs under a work item's lease
 * (`workLease`, #2748): its leased steps get a worktree of their own on
 * `chant/work/<item>`. `declareSteward` refuses such an Op without the lease,
 * and a scheduled Op whose lease leaves the item to the run.
 *
 * ## Beside the turns
 *
 * An Op listed under `beside` (#2861) is the steward's too, but its runs are
 * not turns. A build that takes half an hour would otherwise hold every other
 * Op of the steward, converge included, for its whole length. The local
 * operator starts a run of it as a `chant run <op>` process of its own, with
 * `CHANT_STEWARD` set so the run is still the steward's, and goes on with its
 * rounds. One run at a time: the run holds the Op's own lease
 * (`refs/chant/lease/<op>`), renewed while it runs, and never the turn lease.
 * The operator starts one on the Op's cron, when its `ready` step says there
 * is work, or to resume a run of the steward's that waited on a question now
 * answered (or a gate now approved).
 *
 * ```ts
 * export const steward = declareSteward({
 *   name: "box-steward",
 *   ops: [converge, release],
 *   beside: [{ op: dispatch, ready: shell("node ops/ready.mjs", { json: true }) }],
 * });
 * ```
 *
 * `ops` on the normalised declaration is every Op the steward runs, beside
 * ones last, so a reader that only asks "whose Op is this" (discovery's
 * two-writers check, `chant run`, `workspace status`) needs nothing new.
 * `beside` names the ones that run beside the turns.
 */

import type { ActivityStep, OpConfig } from "./types";
import { collectStepOutputRefs } from "./step-output-ref";
import { isValidCronExpression, cronSyntaxMessage } from "./cron";
import { workLeaseNeedsRunItem, workLeaseProblems } from "./work-lease-decl";

/** The entity marker a steward declaration carries. */
export const STEWARD_KIND = "Chant::Steward";

/** Where a steward runs. */
export const STEWARD_FORMS = ["local", "fountain"] as const;
export type StewardForm = (typeof STEWARD_FORMS)[number];

/** The form a declaration asks for, as given: one form, or a default with per-environment exceptions. */
export type StewardFormSpec = StewardForm | { default: StewardForm; environments?: Record<string, StewardForm> };

/** The environment a form is chosen for when none is named: the same default a run ledger uses. */
export const DEFAULT_STEWARD_ENV = "local";

/** Names a steward's lease ref and a ledger path can hold. */
export const STEWARD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * An Op a steward runs, however the project holds it: the `Op()` declaration
 * (config behind `.props`), or the bare config.
 */
export type StewardOpInput = OpConfig | { props: unknown };

/**
 * An Op that runs beside the steward's turns (#2861): the Op alone, or the
 * Op with the step that says when there is work for it.
 */
export type StewardBesideInput = StewardOpInput | { op: StewardOpInput; ready?: ActivityStep };

/** An Op that runs beside the steward's turns, normalised. */
export interface StewardBeside {
  /** The Op's name; its config is in the declaration's `ops`. */
  readonly op: string;
  /**
   * The step the operator runs each round, while no run of the Op is in
   * flight, to ask whether there is work: see {@link readinessKeys}. Null
   * for an Op started only on its cron, to resume a run, or by hand.
   */
  readonly ready: ActivityStep | null;
}

export interface StewardDeclarationConfig {
  /** The steward's name. On Fountain, the Agent's and the Teammate's. */
  name: string;
  /** The Ops it runs. A scheduled one runs on its cron; any other runs when asked. */
  ops: StewardOpInput[];
  /**
   * Ops it runs beside its turns (#2861), each in a process of its own under
   * the Op's own lease, so a long run holds none of `ops` up. See the module
   * doc.
   */
  beside?: StewardBesideInput[];
  /** Where it runs. Default `local`. */
  form?: StewardFormSpec;
  /**
   * The box capabilities its Ops reach through the box's broker (#2726), by
   * the names the member's `box` block in the workspace declaration gives
   * them, such as `fountain` or `inference`. A steward that names any holds no
   * credential of its own, so it takes no `vault`.
   */
  capabilities?: string[];
  /** The vault the steward holds on Fountain, by name, for a steward that isn't behind a broker. */
  vault?: string;
}

/** A steward's declaration, normalised. Plain data: see the module doc. */
export interface StewardDeclaration {
  readonly kind: typeof STEWARD_KIND;
  readonly name: string;
  /** Every Op it runs: its turns' Ops, then those that run beside them. */
  readonly ops: readonly OpConfig[];
  /**
   * The Ops of `ops` that run beside its turns (#2861). Read it through
   * {@link stewardBesideOf}: a declaration made by an older core has none.
   */
  readonly beside?: readonly StewardBeside[];
  readonly form: { readonly default: StewardForm; readonly environments: Readonly<Record<string, StewardForm>> };
  /** Brokered box capabilities its Ops use (#2726). Empty when it names none. */
  readonly capabilities: readonly string[];
  /** The vault it holds, by name, or null. Never set together with `capabilities`. */
  readonly vault: string | null;
}

/** The config inside an op, whether it arrived as a declaration or as itself. */
export function stewardOpConfig(op: StewardOpInput): OpConfig {
  const declared = (op as { props?: unknown }).props;
  return (declared && typeof declared === "object" ? declared : op) as OpConfig;
}

function checkForm(steward: string, form: unknown, where: string): StewardForm {
  if (!STEWARD_FORMS.includes(form as StewardForm)) {
    throw new Error(`Steward "${steward}": ${where} is ${JSON.stringify(form)}; a steward's form is "local" or "fountain"`);
  }
  return form as StewardForm;
}

/** Normalise a form spec, refusing an unknown form or an environment name no ledger could hold. */
export function normaliseStewardForm(steward: string, spec: StewardFormSpec | undefined): StewardDeclaration["form"] {
  if (spec === undefined) return { default: "local", environments: {} };
  if (typeof spec === "string") return { default: checkForm(steward, spec, "form"), environments: {} };
  const environments: Record<string, StewardForm> = {};
  for (const [env, form] of Object.entries(spec.environments ?? {})) {
    if (!STEWARD_NAME_PATTERN.test(env) || env.includes("..")) {
      throw new Error(`Steward "${steward}": form.environments names ${JSON.stringify(env)}, which can't be an environment`);
    }
    environments[env] = checkForm(steward, form, `form.environments[${JSON.stringify(env)}]`);
  }
  return { default: checkForm(steward, spec.default, "form.default"), environments };
}

/** A `beside` entry's Op and ready step, whichever of the two forms it was given in. */
function besideEntry(entry: StewardBesideInput): { op: OpConfig; ready: ActivityStep | null } {
  const e = entry as { op?: unknown; ready?: ActivityStep; phases?: unknown; props?: unknown };
  if (e && typeof e === "object" && e.op !== undefined && e.phases === undefined && e.props === undefined) {
    return { op: stewardOpConfig(e.op as StewardOpInput), ready: e.ready ?? null };
  }
  return { op: stewardOpConfig(entry as StewardOpInput), ready: null };
}

/**
 * Declare a steward. Refuses what would make it more than one writer or a
 * promise it can't keep: an Op listed twice, a schedule whose overlap isn't
 * `skip` (a fire while a turn runs is dropped in both forms), a cron that
 * doesn't parse, and a name a lease ref can't hold. For an Op beside the
 * turns (#2861), also a `ready` that is not one activity step, or that reads
 * another step's output (it runs on its own, outside any run).
 */
export function declareSteward(config: StewardDeclarationConfig): StewardDeclaration {
  const name = config.name;
  if (!STEWARD_NAME_PATTERN.test(name) || name.includes("..")) {
    throw new Error(
      `Steward ${JSON.stringify(name)}: a steward's name is letters, digits, ".", "_" and "-", starting with a letter or digit`,
    );
  }
  const besides = (config.beside ?? []).map(besideEntry);
  const ops = [...config.ops.map(stewardOpConfig), ...besides.map((b) => b.op)];
  const seen = new Set<string>();
  for (const op of ops) {
    if (!op || typeof op.name !== "string" || !Array.isArray(op.phases)) {
      throw new Error(`Steward "${name}": every entry in ops must be an Op`);
    }
    if (seen.has(op.name)) throw new Error(`Steward "${name}": op "${op.name}" is listed twice`);
    seen.add(op.name);
    // An Op that changes the checkout runs under a work item's lease, on a
    // branch of its own (#2748): one that doesn't declare the lease, or
    // declares it badly, is refused here as the executor would refuse it.
    const leaseProblems = workLeaseProblems(op);
    if (leaseProblems.length > 0) throw new Error(`Steward "${name}": ${leaseProblems.join("; ")}`);
    if (op.schedule && workLeaseNeedsRunItem(op)) {
      throw new Error(
        `Steward "${name}": op "${op.name}" is scheduled, but its workLease names no item, and a scheduled run can't be given one. ` +
          `Name the item, candidates, or the step whose output picks it.`,
      );
    }
    const beside = besides.find((b) => b.op === op);
    if (beside?.ready) {
      const ready = beside.ready;
      if (!ready || ready.kind !== "activity" || typeof ready.fn !== "string") {
        throw new Error(`Steward "${name}": op "${op.name}": ready is one activity step, such as shell("...", { json: true })`);
      }
      if (collectStepOutputRefs(ready.args ?? {}).length > 0) {
        throw new Error(`Steward "${name}": op "${op.name}": its ready step reads another step's output, and it runs outside any run`);
      }
      if (workLeaseNeedsRunItem(op)) {
        throw new Error(
          `Steward "${name}": op "${op.name}" is started when its ready step says so, but its workLease names no item, and such a run can't be given one. ` +
            `Name the item, candidates, or the step whose output picks it.`,
        );
      }
    }
    const schedule = op.schedule;
    if (!schedule) continue;
    if (!isValidCronExpression(schedule.cron)) {
      throw new Error(`Steward "${name}": op "${op.name}": ${cronSyntaxMessage(schedule.cron)}`);
    }
    if (schedule.overlap !== undefined && schedule.overlap !== "skip") {
      throw new Error(
        `Steward "${name}": op "${op.name}" schedules overlap "${schedule.overlap}". ` +
          `A fire while the steward is busy is dropped, so "skip" is the only policy a steward can honour.`,
      );
    }
  }
  const capabilities = [...new Set(config.capabilities ?? [])];
  for (const c of capabilities) {
    if (typeof c !== "string" || c.trim() === "") throw new Error(`Steward "${name}": a capability is named by a non-empty string`);
  }
  const vault = config.vault ?? null;
  if (vault !== null && capabilities.length > 0) {
    throw new Error(
      `Steward "${name}": it reaches ${capabilities.join(", ")} through the box's broker and also holds the vault "${vault}". ` +
        `A brokered steward holds no credential of its own: drop the vault, or name no capabilities.`,
    );
  }
  return Object.freeze({
    kind: STEWARD_KIND,
    name,
    ops: Object.freeze([...ops]),
    beside: Object.freeze(besides.map((b) => Object.freeze({ op: b.op.name, ready: b.ready }))),
    form: normaliseStewardForm(name, config.form),
    capabilities: Object.freeze(capabilities),
    vault,
  });
}

/** Is this value a steward declaration? Duck-typed, like `isOpEntity`. */
export function isStewardDeclaration(value: unknown): value is StewardDeclaration {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<StewardDeclaration>;
  return (
    v.kind === STEWARD_KIND &&
    typeof v.name === "string" &&
    Array.isArray(v.ops) &&
    !!v.form &&
    typeof v.form === "object" &&
    typeof v.form.default === "string"
  );
}

/** The Ops a steward runs beside its turns (#2861); none for a declaration without the field. */
export function stewardBesideOf(steward: StewardDeclaration): readonly StewardBeside[] {
  return Array.isArray(steward.beside) ? steward.beside : [];
}

/** The entry for `op` when the steward runs it beside its turns (#2861), or undefined. */
export function stewardBesideFor(steward: StewardDeclaration, op: string): StewardBeside | undefined {
  return stewardBesideOf(steward).find((b) => b.op === op);
}

/** The Ops a steward runs as its turns, one at a time: `ops` without the beside ones. */
export function stewardTurnOps(steward: StewardDeclaration): OpConfig[] {
  const beside = new Set(stewardBesideOf(steward).map((b) => b.op));
  return steward.ops.filter((op) => !beside.has(op.name));
}

/**
 * What a `ready` step's result says (#2861): the work keys it names, or null
 * when its result is not one of the shapes below. The value read is the
 * result's `json` when it has one (a `shell` step with `json: true`), or the
 * result itself.
 *
 * - an array: one key per entry (a string as is, anything else as its JSON);
 *   empty means no work;
 * - a non-empty string: one key; `""` means no work;
 * - `true` means work, with no key; `false` and `null` mean none.
 *
 * The operator starts a run when a key is one it has not started a run for
 * yet, so a run that ends with the same work still ready is not started
 * again for it. `true` has no key, so it starts a run whenever none is in
 * flight.
 */
export function readinessKeys(result: unknown): { ready: boolean; keys: string[] } | null {
  const value = result && typeof result === "object" && !Array.isArray(result) && "json" in result
    ? (result as { json: unknown }).json
    : result;
  if (value === true) return { ready: true, keys: [] };
  if (value === false || value === null || value === undefined) return { ready: false, keys: [] };
  if (typeof value === "string") return value === "" ? { ready: false, keys: [] } : { ready: true, keys: [value] };
  if (Array.isArray(value)) {
    const keys = value.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    return { ready: keys.length > 0, keys };
  }
  return null;
}

/** The form a steward takes in `env` (`local` when none is named). */
export function stewardFormFor(steward: Pick<StewardDeclaration, "form">, env: string = DEFAULT_STEWARD_ENV): StewardForm {
  return steward.form.environments[env] ?? steward.form.default;
}

/**
 * The lease a local steward holds for as long as it runs, so a second
 * `chant operator --steward` for the same steward is refused. It sits under
 * `refs/chant/lease/_stewards/`, beside the per-Op leases, which a leading
 * `_` keeps out of any Op's name.
 */
export function stewardLeaseName(steward: string): string {
  return `_stewards/${steward}`;
}

/**
 * The lease a local steward holds for as long as one of its Ops is actually
 * running: one turn (#2750). Distinct from {@link stewardLeaseName}, which one
 * `chant operator --steward` process holds for its whole life (renewed
 * between ticks, released only when the process stops) — this one is taken
 * right before a run starts and released right after it ends, whether the
 * run is a round's scheduled tick or `chant run <op>` typed by hand. That is
 * what makes an on-request run wait its turn behind a turn already in
 * progress, and succeed again the moment that turn ends, rather than only
 * once the whole steward process stops.
 *
 * `_turns/<name>`, not `_stewards/<name>/turn`: a git ref name is a path
 * component in the loose-refs tree, and `refs/chant/lease/_stewards/<name>`
 * (the lease {@link stewardLeaseName} names) already exists as a *leaf* —
 * git refuses to also create anything *under* it (`fatal: ... exists;
 * cannot create ...`), so nesting the turn lease inside the steward lease's
 * own name is unusable the moment both are live at once. A sibling
 * top-level segment sidesteps that entirely.
 */
export function stewardTurnLeaseName(steward: string): string {
  return `_turns/${steward}`;
}

/**
 * Pick the steward `--steward [<name>]` names, or the project's only one.
 * Returns the steward, or the message to refuse with.
 */
export function pickSteward(
  stewards: Map<string, { declaration: StewardDeclaration }>,
  name: string,
): StewardDeclaration | string {
  if (name) {
    const found = stewards.get(name);
    if (found) return found.declaration;
    const known = [...stewards.keys()].sort();
    return `No steward "${name}" is declared` + (known.length ? ` (declared: ${known.join(", ")})` : " (no *.op.ts file exports one)");
  }
  if (stewards.size === 1) return [...stewards.values()][0].declaration;
  if (stewards.size === 0) return "No steward is declared: export declareSteward({...}) (or the fountain Steward's declaration) from an *.op.ts file";
  return `${stewards.size} stewards are declared (${[...stewards.keys()].sort().join(", ")}); name one with --steward <name>`;
}
