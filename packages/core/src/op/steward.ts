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
 * `chant/lifecycle` branch and lease refs under `refs/chant/lease/`, all made
 * with git plumbing (`../lifecycle/git.ts`: `hash-object`, `mktree`,
 * `commit-tree`, `update-ref`). None of them reads or writes the checkout's
 * index or working tree, so a coding agent editing the app in the same
 * checkout, and holding git's index lock while it commits, never collides with
 * a steward turn. The app's files are the coding agent's; the steward does not
 * edit them.
 */

import type { OpConfig } from "./types";
import { isValidCronExpression, cronSyntaxMessage } from "./cron";

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

export interface StewardDeclarationConfig {
  /** The steward's name. On Fountain, the Agent's and the Teammate's. */
  name: string;
  /** The Ops it runs. A scheduled one runs on its cron; any other runs when asked. */
  ops: StewardOpInput[];
  /** Where it runs. Default `local`. */
  form?: StewardFormSpec;
}

/** A steward's declaration, normalised. Plain data: see the module doc. */
export interface StewardDeclaration {
  readonly kind: typeof STEWARD_KIND;
  readonly name: string;
  readonly ops: readonly OpConfig[];
  readonly form: { readonly default: StewardForm; readonly environments: Readonly<Record<string, StewardForm>> };
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

/**
 * Declare a steward. Refuses what would make it more than one writer or a
 * promise it can't keep: an Op listed twice, a schedule whose overlap isn't
 * `skip` (a fire while a turn runs is dropped in both forms), a cron that
 * doesn't parse, and a name a lease ref can't hold.
 */
export function declareSteward(config: StewardDeclarationConfig): StewardDeclaration {
  const name = config.name;
  if (!STEWARD_NAME_PATTERN.test(name) || name.includes("..")) {
    throw new Error(
      `Steward ${JSON.stringify(name)}: a steward's name is letters, digits, ".", "_" and "-", starting with a letter or digit`,
    );
  }
  const ops = config.ops.map(stewardOpConfig);
  const seen = new Set<string>();
  for (const op of ops) {
    if (!op || typeof op.name !== "string" || !Array.isArray(op.phases)) {
      throw new Error(`Steward "${name}": every entry in ops must be an Op`);
    }
    if (seen.has(op.name)) throw new Error(`Steward "${name}": op "${op.name}" is listed twice`);
    seen.add(op.name);
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
  return Object.freeze({
    kind: STEWARD_KIND,
    name,
    ops: Object.freeze([...ops]),
    form: normaliseStewardForm(name, config.form),
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

/** The form a steward takes in `env` (`local` when none is named). */
export function stewardFormFor(steward: StewardDeclaration, env: string = DEFAULT_STEWARD_ENV): StewardForm {
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
