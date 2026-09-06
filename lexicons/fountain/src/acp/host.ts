/**
 * What a turn needs from chant, stated once (#2125).
 *
 * The ACP server owns the protocol — sessions, updates, stop reasons — and
 * nothing else. Everything it does *to a project* goes through this seam:
 * finding an Op, starting it on a runtime provider, running any other chant
 * verb, and recording a gate resolution. The conformance test drives the
 * protocol through a stub host, so the tool-call ordering, the cancel path and
 * the gated reply are tested without a checkout, a git branch or a real Op.
 *
 * The real implementation is `createChantHost`, and it is deliberately thin:
 * `createLocalOpRuntime` from core is the provider (#2121), `discoverOps` is
 * the lookup, and a verb runs through core's own registry handler rather than
 * a reimplementation of it. Nothing here shells out — a prompt is parsed and
 * dispatched in this process, so there is no line for a shell to interpret.
 */

import type { OpConfig } from "@intentius/chant/op/types";
import type { OpRunHandle, OpRunStartOptions } from "@intentius/chant/op/runtime";
import type { ChantCommand } from "./command-line";

/**
 * What one `*.op.ts` scan found.
 *
 * `errors` is carried rather than dropped because the failure mode it names is
 * indistinguishable from the innocent one: an Op file that will not import
 * reports as "no such Op", and a person reading that in a thread has been told
 * the wrong thing. `chant run` prints these as warnings; so does a turn.
 */
export interface OpLookup {
  /** The Op the prompt named, when the scan found it. */
  config?: OpConfig;
  /** Every Op name the scan did find, for the "not declared" reply's hint. */
  names: string[];
  /** Files the scan could not read as an Op. */
  errors: string[];
}

/** The project-facing half of a turn. */
export interface ChantHost {
  /** Where chant runs — the session's `cwd`. */
  readonly cwd: string;
  /** Scan the project for Ops and pick out the one this name declares. */
  findOp(name: string): Promise<OpLookup>;
  /** Start an Op on the resolved runtime provider. */
  startOp(op: OpConfig, opts: OpRunStartOptions): Promise<OpRunHandle>;
  /** Run a non-`run` chant verb. Returns its exit code; output goes to the process writers. */
  runVerb(command: Extract<ChantCommand, { kind: "verb" }>, signal: AbortSignal): Promise<number>;
  /** Record a gate resolution, the way `chant approve` does (durable-request resume). */
  resolveGate(op: string, gate: string, resolvedBy: string): Promise<void>;
}

/** How the real host identifies itself on a gate resolution it writes. */
export const ACP_APPROVER = "chant-acp";

/**
 * The real host, bound to one session's working directory.
 *
 * Core's machinery reads the project from `process.cwd()`, so a turn changes
 * into `cwd` for its duration (see ./turn.ts) rather than threading a path
 * through every call — which is also why turns are serialized. Every import
 * below is dynamic: declaring the fountain lexicon must not pull core's CLI
 * handlers into a `chant build`.
 */
export function createChantHost(cwd: string): ChantHost {
  return {
    cwd,

    async findOp(name) {
      const { discoverOps } = await import("@intentius/chant/op/discover");
      const { ops, errors } = await discoverOps({ cwd });
      return {
        ...(ops.get(name) ? { config: ops.get(name)?.config } : {}),
        names: [...ops.keys()],
        errors,
      };
    },

    async startOp(op, opts) {
      const { createLocalOpRuntime } = await import("@intentius/chant/op/runtimes/local");
      return createLocalOpRuntime({ projectPath: cwd }).start(op, opts);
    },

    async runVerb(command) {
      const { loadPlugins, resolveProjectLexicons } = await import("@intentius/chant/cli/plugins");
      const plugins = command.def.requiresPlugins
        ? await loadPlugins(await resolveProjectLexicons(cwd).catch(() => [])).catch(() => [])
        : [];
      return command.def.handler({
        args: command.args,
        plugins,
        serializers: plugins.map((p) => p.serializer),
      });
    },

    async resolveGate(op, gate, resolvedBy) {
      const { appendGateResolution } = await import("@intentius/chant/lifecycle/gate-ledger");
      await appendGateResolution(
        { op, gate, resolvedBy, timestamp: new Date().toISOString() },
        { cwd },
      );
    },
  };
}
