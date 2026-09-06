/**
 * Steward — the one writer for an environment (#2127, epic #2115).
 *
 * A steward is an `Agent` that speaks the Agent Client Protocol over `chant
 * acp` on a persistent sandbox, bound to the team as a `Teammate` so it has a
 * standing conversation, with a `Schedule` per scheduled op and an optional
 * `Webhook` for whoever has to hear about a turn. The teammate's thread is
 * that environment's operational history: every turn is one chant command
 * line, so scrolling the thread is scrolling what was done.
 *
 * ```ts
 * export const { agent, teammate, schedules, webhook } = Steward({
 *   name: "prod-steward",
 *   environment: toolchain,
 *   vault: prodCreds,
 *   ops: [watch.op, converge.op, apply.op],
 *   webhook: { url: "https://hooks.example.com/chant" },
 * });
 * ```
 *
 * The defaults are the ones a machine that runs chant needs and no others:
 * `sandbox_mode: "persistent"` because the environment's checkout and tool
 * cache have to survive a turn ending, `permission_policy: { default:
 * "auto_allow" }` because there is nobody at the keyboard to answer a
 * permission card and chant's own gates are where a human belongs, no `model`
 * because an `acp` agent's model is whatever the command it launches decides
 * to use, and no skills because a steward's competence is chant's op
 * definitions rather than prose.
 *
 * ## Why it refuses things
 *
 * Two stewards on one environment and vault is two writers on one machine,
 * which is the exact thing a single thread exists to prevent — fountain would
 * accept both, and their turns would interleave on the same checkout. An op
 * whose `schedule.overlap` is not `skip` asks for a backlog fountain has no
 * way to queue: a schedule that fires while the teammate is busy is dropped
 * with `teammate was busy`, so any other overlap policy would be a promise
 * the server does not keep. And a webhook url FTN022 would reject is refused
 * here rather than at synth, because a composite that constructed it would be
 * handing the author a lint error about a resource they never typed.
 */

import type { OpConfig } from "@intentius/chant/op";
import { Agent, Environment, Schedule, Teammate, Vault, Webhook } from "../generated/index";
import { isPrivateHost } from "../lint/post-synth/ftn022-webhook-url-public-https";
import { runPrompt } from "../op/run-prompt";
import { propsOf } from "../entity-props";

/** The webhook a steward declares, if any. Shape of fountain's create request. */
export interface StewardWebhookOpts {
  /** Delivery target. https, and not a loopback, link-local or RFC1918 host. */
  url: string;
  /** Subscribed event types. fountain's own default when omitted. */
  event_types?: string[];
  description?: string;
}

export interface StewardOpts {
  /** The steward's name — the Agent's, and the Teammate's. */
  name: string;
  /** The environment its computer is provisioned from: repo, chant, tooling. */
  environment: InstanceType<typeof Environment>;
  /** Secrets layered on top. Omit under the egress broker, which holds them. */
  vault?: InstanceType<typeof Vault>;
  /**
   * The ops this steward runs. An op with a `schedule` gets a `Schedule`; one
   * without is still listed, so `chant run <op> --on fountain` knows which
   * thread the run belongs on.
   */
  ops: OpConfig[];
  webhook?: StewardWebhookOpts;
  /** Extra metadata merged over the `managed-by` marker on the Agent. */
  metadata?: Record<string, unknown>;
}

export interface StewardResources {
  agent: InstanceType<typeof Agent>;
  teammate: InstanceType<typeof Teammate>;
  /** One per op that carries a `schedule`, in `ops` order. */
  schedules: InstanceType<typeof Schedule>[];
  webhook?: InstanceType<typeof Webhook>;
}

/** The command an `acp` agent speaks the protocol over (#2125). */
export const STEWARD_RUNTIME_COMMAND = "chant acp";

// ── The declaration registry ──────────────────────────────────────────────
//
// Two maps, both filled at construction and read by nothing that mutates
// them. The first is what makes the two-writers refusal possible at all — a
// composite only ever sees its own call, so the binding it claims has to be
// recorded somewhere the next call can see. The second is what
// `op/runtime.ts` reads to send `chant run <op> --on fountain` to the right
// thread without the author repeating the teammate name in a profile.

/** `environment name \0 vault name` → the steward that claimed it. */
const bindings = new Map<string, string>();

/** Op name → the teammate whose thread it runs on. */
const opStewards = new Map<string, string>();

/** The teammate an Op runs on, when a `Steward` in this process declared one. */
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

/** Refuse a webhook url on exactly FTN022's terms, before the resource exists. */
function checkWebhookUrl(steward: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Steward "${steward}": webhook url "${url}" is not a URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Steward "${steward}": webhook url "${url}" is ${parsed.protocol.replace(":", "")}, not https — ` +
        `turn payloads would cross the network in the clear`,
    );
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(
      `Steward "${steward}": webhook url "${url}" targets the private host "${parsed.hostname}" — ` +
        `fountain refuses loopback, link-local and RFC1918 delivery targets`,
    );
  }
}

export function Steward(opts: StewardOpts): StewardResources {
  const metadata = { "managed-by": "chant", ...(opts.metadata ?? {}) };

  // One writer per environment. The binding is the pair the sandbox identity
  // is keyed on upstream (agent, environment, vault), minus the agent — two
  // agents sharing the rest are two processes on one checkout.
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

  for (const op of opts.ops) {
    const overlap = op.schedule?.overlap;
    if (overlap !== undefined && overlap !== "skip") {
      throw new Error(
        `Steward "${opts.name}": op "${op.name}" schedules overlap "${overlap}" — ` +
          `a fountain schedule that fires while the teammate is busy is dropped, ` +
          `so "skip" is the only policy the server can honour.`,
      );
    }
  }

  if (opts.webhook) checkWebhookUrl(opts.name, opts.webhook.url);

  const agent = new Agent({
    name: opts.name,
    runtime: "acp",
    runtime_command: STEWARD_RUNTIME_COMMAND,
    sandbox_mode: "persistent",
    environment: opts.environment,
    permission_policy: { default: "auto_allow" },
    // Scoped to the vault it was given, and to nothing when it was given
    // none: an empty list forbids a conversation attaching any vault at all,
    // which is the closed reading of "this machine holds these secrets". The
    // entry is the Vault declaration rather than its `.id` attribute, because
    // the manifest's reference form is the resource's name (FTN021's rule)
    // and an AttrRef would serialize to the chant export name instead.
    allowed_vault_ids: opts.vault ? [opts.vault] : [],
    metadata,
  });

  const teammate = new Teammate({
    name: opts.name,
    agent,
    environment: opts.environment,
    ...(opts.vault ? { vault: opts.vault } : {}),
  });

  const schedules: InstanceType<typeof Schedule>[] = [];
  for (const op of opts.ops) {
    if (!op.schedule) continue;
    schedules.push(
      new Schedule({
        name: `${opts.name}-${op.name}`,
        teammate,
        cron: op.schedule.cron,
        prompt: runPrompt(op.name),
        // In-thread, so a fire while the previous run is still going is
        // dropped rather than opening a second computer beside the first.
        one_off: false,
        enabled: true,
      }),
    );
  }

  const webhook = opts.webhook
    ? new Webhook({
        url: opts.webhook.url,
        ...(opts.webhook.event_types ? { event_types: opts.webhook.event_types } : {}),
        ...(opts.webhook.description !== undefined ? { description: opts.webhook.description } : {}),
      })
    : undefined;

  bindings.set(binding, opts.name);
  for (const op of opts.ops) opStewards.set(op.name, opts.name);

  return { agent, teammate, schedules, ...(webhook ? { webhook } : {}) };
}
