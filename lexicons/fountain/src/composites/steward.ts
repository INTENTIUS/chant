/**
 * Steward — the one writer for an environment (#2127, epic #2115).
 *
 * A steward is an `Agent` that speaks the Agent Client Protocol over `chant
 * acp`, whose turns all land on one long-lived conversation: `chant run <op>
 * --on fountain` opens it the first time and resumes it after that, by
 * `channel_id` `chant:steward:<name>`. That conversation is the
 * environment's operational history: every turn is one chant command line,
 * so scrolling it is scrolling what was done. Its sandbox keeps its disk
 * across park and wake and is destroyed only when the conversation is
 * terminated, so the checkout and tool cache survive a turn ending.
 *
 * ```ts
 * export const { agent, declaration } = Steward({
 *   name: "prod-steward",
 *   environment: toolchain,
 *   vault: prodCreds,
 *   ops: [watch.op, converge.op, apply.op],
 * });
 * ```
 *
 * ## What Managoat no longer does for it (managoat/managoat#2793)
 *
 * A steward used to be a persistent-sandbox Agent seated on the team as a
 * `Teammate`, with a `Schedule` per scheduled op and an optional `Webhook`.
 * Managoat removed all four: every conversation gets a sandbox of its own
 * (its ADR 0073), and there is no team, no scheduler (ADR 0074) and no
 * webhook. So the Agent declares no `sandbox_mode`, and nothing here declares
 * a schedule. An Op's `schedule` stays on the declaration below, and a clock
 * outside Managoat fires it: a CI `schedule:` or a CronJob running `chant run
 * <op> --on fountain` (or `--on e2b`, which runs the Op on a sandbox of your
 * own), or, in an environment whose form is `local`, `chant operator
 * --steward`. `webhook` is refused by name; read a run's
 * outcome from `chant run` or the conversation's event stream instead.
 *
 * The defaults are the ones a machine that runs chant needs and no others:
 * `permission_policy: { default: "auto_allow" }` because there is nobody at
 * the keyboard to answer a permission card. Chant's own gates are still where
 * a human belongs, and that is enforced rather than assumed: a gate resolved
 * from this session would be answering a gate this session produced, which
 * `recordGateApproval` refuses (chant#2384's origin rule, reached through
 * chant#2400). So `auto_allow` decides ordinary tool calls and
 * cannot clear a gate — the resolution has to arrive on a channel this agent
 * is not on, normally `chant approve` at a shell. No `model`, because an `acp` agent's
 * model is whatever the command it launches decides to use, and no skills
 * because a steward's competence is chant's op definitions rather than prose.
 *
 * ## Why it refuses things
 *
 * Two stewards on one environment and vault is two writers on one checkout,
 * which is the exact thing a single conversation exists to prevent —
 * fountain would accept both, and their turns would interleave on the same
 * environment.
 *
 * ## One steward whatever the preset (#2731)
 *
 * The composite also returns `declaration`, the steward as core reads it
 * (`declareSteward` in `@intentius/chant/op`): its name, its Ops and its
 * `form`. A box whose preset has no Fountain in some environment (a docker
 * compose box, a Sprites box) sets `form` so that environment is `local`, and
 * there `chant operator --steward <name>` runs the same Ops on the same crons,
 * one at a time, each under its operator lease and the whole process under the
 * steward's own. `chant operator --steward` refuses an environment whose form
 * is `fountain`, because this Agent's conversation is the steward there. Export
 * `declaration` from an `*.op.ts` file so the operator and `chant workspace
 * status` find it.
 *
 * ## Credentials (#2726)
 *
 * A box's steward holds no credential. Name the box capabilities its Ops use
 * in `capabilities` (the names the member's `box` block in the workspace
 * declaration gives them) and leave `vault` out: the broker holds the key and
 * enforces the scope. `vault` together with `capabilities` is refused.
 * `chant workspace check` fails a box member whose files hold a literal secret
 * (`box-credential-declared`), and `chant workspace status --json` lists each
 * capability the steward names with the broker the box block gives it.
 *
 * ## Decision points (chant#2749)
 *
 * The Agent runs `chant acp --steward <name>`, so every turn is this
 * steward's. An Op that asks a decision point during a turn
 * (`askPointInRun` in `@intentius/chant/op`) makes its model call only
 * through a capability named in `capabilities`, and a question that is still
 * open ends the run as `waiting`, as a gate ends it as `gated`. The question
 * stays in the workspace, where `points --open`, `workspace status --json`
 * and hud find it, and a person answers it. It is never asked on this
 * conversation, and `points answer` from this session is refused. The Op's next
 * turn reads the answer.
 *
 * ## The coding agent beside it
 *
 * A box also has a coding agent editing the app. They share the checkout by
 * writing different things. The steward's writes are chant writes: run,
 * converge and gate records on the `chant/lifecycle` branch and lease refs
 * under `refs/chant/lease/`, made with git plumbing that never reads or writes
 * the index or the working tree. The app's files, the index and commits on the
 * working branch are the coding agent's. An Op a steward runs does not edit the
 * app. A change to the checkout that an Op has to make (applying a build, a
 * workspace upgrade) belongs under the work item's lease (ws-055), on a branch
 * of its own, never in the coding agent's working tree.
 */

import { declareSteward, type StewardDeclaration, type StewardFormSpec } from "@intentius/chant/op";
import type { OpConfig, OpResource } from "@intentius/chant/op";
import { Agent, Environment, Vault } from "../generated/index";
import { propsOf } from "../entity-props";

/**
 * An op a steward runs, however the project happens to hold it.
 *
 * `WatchOp`, `ConvergeOp`, `ApplyOp` and `ReconcileOp` all hand back an `Op`
 * declaration rather than the config they were given, and that declaration
 * keeps its config behind `props` — so `ops: [watch.op]`, which is what an
 * author has in hand, is the common case and not the exception. A bare
 * `OpConfig` object is accepted too, because an Op assembled by hand never
 * becomes a declaration until `Op()` is called on it.
 */
export type StewardOp = OpConfig | InstanceType<typeof OpResource>;

/** The config inside an op, whether it arrived as a declaration or as itself. */
function configOf(op: StewardOp): OpConfig {
  const declared = (op as { props?: unknown }).props;
  return (declared && typeof declared === "object" ? declared : op) as OpConfig;
}

export interface StewardOpts {
  /** The steward's name — the Agent's, and its conversation's `channel_id` suffix. */
  name: string;
  /** The environment its computer is provisioned from: repo, chant, tooling. */
  environment: InstanceType<typeof Environment>;
  /**
   * Secrets layered on top, for a steward that isn't behind a broker. Omit it
   * under a broker, which holds them, and name `capabilities` instead.
   */
  vault?: InstanceType<typeof Vault>;
  /**
   * The box capabilities this steward's Ops reach through the box's broker
   * (#2726), by the names the member's `box` block declares, such as
   * `fountain` or `inference`. Refused together with `vault`: a brokered
   * steward holds no credential.
   */
  capabilities?: string[];
  /**
   * The ops this steward runs, so `chant run <op> --on fountain` knows which
   * conversation the run belongs on. An op's `schedule` is carried on the
   * declaration for a clock outside Managoat to fire; nothing here schedules it.
   */
  ops: StewardOp[];
  /** Extra metadata merged over the `managed-by` marker on the Agent. */
  metadata?: Record<string, unknown>;
  /**
   * Where this steward runs (#2731). Default `fountain`: this composite's
   * Agent, and its one conversation, are the steward. A box whose preset has no Fountain in
   * some environment names it here, e.g. `{ default: "fountain", environments:
   * { minimal: "local" } }`, and `chant operator --steward <name> --env minimal`
   * runs the same Ops there. The Fountain resources are declared either way; a
   * form that is `local` everywhere is refused, since it needs none of them
   * (use core's `declareSteward` for that).
   */
  form?: StewardFormSpec;
}

export interface StewardResources {
  agent: InstanceType<typeof Agent>;
  /**
   * The steward as core reads it (#2731): name, Ops and form. Export it from
   * an `*.op.ts` file so `chant operator --steward` and `chant workspace
   * status` find it.
   */
  declaration: StewardDeclaration;
}

/** The command an `acp` agent speaks the protocol over (#2125). */
export const STEWARD_RUNTIME_COMMAND = "chant acp";

/**
 * A steward's Agent command: `chant acp --steward <name>` (chant#2749), so the
 * session knows whose turns it serves. A steward's name is letters, digits,
 * `.`, `_` and `-` (`declareSteward` refuses anything else), so it needs no
 * quoting.
 */
export function stewardRuntimeCommand(name: string): string {
  return `${STEWARD_RUNTIME_COMMAND} --steward ${name}`;
}

// ── The declaration registry ──────────────────────────────────────────────
//
// Two maps, both filled at construction and read by nothing that mutates
// them. The first is what makes the two-writers refusal possible at all — a
// composite only ever sees its own call, so the binding it claims has to be
// recorded somewhere the next call can see. The second is what
// `op/runtime.ts` reads to send `chant run <op> --on fountain` to the right
// conversation without the author repeating the steward's name in a profile.

/** `environment name \0 vault name` → the steward that claimed it. */
const bindings = new Map<string, string>();

/** Op name → the steward whose conversation it runs on. */
const opStewards = new Map<string, string>();

/** The steward an Op runs on, when a `Steward` in this process declared one. */
export function stewardForOp(op: string): string | undefined {
  return opStewards.get(op);
}

/** Drop every declaration. Tests only — a process declares each steward once. */
export function __resetStewardsForTests(): void {
  bindings.clear();
  opStewards.clear();
}

/** An entity's fountain name — its declared `name` prop. */
function nameOf(entity: unknown): string {
  const declared = propsOf(entity).name;
  return typeof declared === "string" ? declared : "";
}

export function Steward(opts: StewardOpts): StewardResources {
  // The type no longer has it; this is for an untyped caller still passing
  // the old option, so it fails at build with the reason rather than vanishing.
  if ((opts as { webhook?: unknown }).webhook !== undefined) {
    throw new Error(
      `Steward "${opts.name}": webhook is gone — Managoat removed webhooks (managoat/managoat#2793). ` +
        `Read a run's outcome from chant run, or from the conversation's event stream.`,
    );
  }

  const metadata = { "managed-by": "chant", ...(opts.metadata ?? {}) };
  const ops = opts.ops.map(configOf);

  // One writer per environment. The binding is the environment and vault a
  // steward's conversation is provisioned from — two agents sharing them are
  // two processes writing one environment's records.
  const envName = nameOf(opts.environment);
  const vaultName = opts.vault ? nameOf(opts.vault) : "";
  const binding = `${envName}\0${vaultName}`;
  const claimed = bindings.get(binding);
  if (claimed !== undefined && claimed !== opts.name) {
    throw new Error(
      `Steward "${opts.name}": "${claimed}" already stewards environment "${envName}"` +
        (vaultName ? ` with vault "${vaultName}"` : " with no vault") +
        ` — two stewards on one environment are two writers on one machine. ` +
        `Give this one its own environment, or list its ops on "${claimed}".`,
    );
  }

  // The declaration core reads. Built here, before any resource, so a bad
  // name, a duplicate op or an unknown form is refused with nothing declared.
  const declaration = declareSteward({
    name: opts.name,
    ops,
    form: opts.form ?? "fountain",
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.vault ? { vault: vaultName } : {}),
  });
  const envForms = [declaration.form.default, ...Object.values(declaration.form.environments)];
  if (!envForms.includes("fountain")) {
    throw new Error(
      `Steward "${opts.name}": form is "local" in every environment, so none of the Fountain resources this ` +
        `composite declares would ever run. Declare it with declareSteward from @intentius/chant/op instead.`,
    );
  }

  const agent = new Agent({
    name: opts.name,
    runtime: "acp",
    // The session is this steward's turn (chant#2749): see "Decision points".
    runtime_command: stewardRuntimeCommand(opts.name),
    environment: opts.environment,
    permission_policy: { default: "auto_allow" },
    // Scoped to the vault it was given, and to nothing when it was given
    // none: an empty list forbids a conversation attaching any vault at all,
    // which is the closed reading of "this machine holds these secrets". The
    // entry is the Vault declaration rather than its `.id` attribute, because
    // the manifest's reference form is the resource's name, and an AttrRef
    // would serialize to the chant export name instead.
    allowed_vault_ids: opts.vault ? [opts.vault] : [],
    metadata,
  });

  bindings.set(binding, opts.name);
  for (const op of ops) opStewards.set(op.name, opts.name);

  return { agent, declaration };
}
