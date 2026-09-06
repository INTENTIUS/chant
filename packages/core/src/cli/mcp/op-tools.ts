/**
 * MCP tools over Ops (#2121: on the runtime seam, not on a Temporal client).
 *
 * Every tool here goes through an {@link OpRuntimeProvider} — the built-in
 * `local` one by default, or the `runtime` argument's lexicon `opRuntime` when
 * an agent names one. One provider is built per call, so a long-lived server
 * picks up a project's config as it is now rather than as it was at boot; the
 * local provider's in-process run history is the exception and is held for the
 * life of the module, so `op-status` can answer for a run `op-run` started.
 *
 * #2118 owns the ledger-backed record shape; when it lands, `status`/`log`
 * read the ledger and this file stops depending on the process outliving the
 * run.
 */

import { resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { createLocalOpRuntime } from "../../op/runtimes/local";
import type { OpRuntimeProvider } from "../../op/runtime";
import { loadChantConfig } from "../../config";
import { loadPlugins } from "../plugins";
import { recordGateApproval } from "../handlers/operator";
import type { ToolRegistration } from "./lifecycle-tools";

/** The `local` provider, shared so an `op-run` is visible to a later `op-status`. */
let localRuntime: OpRuntimeProvider | undefined;

/**
 * Resolve the runtime a tool call addresses. `runtime` names a configured
 * lexicon's `opRuntime`; omitted (or `local`) it is core's built-in provider.
 * Throws with an actionable message — the MCP layer turns that into `isError`.
 */
async function runtimeFor(name: unknown): Promise<OpRuntimeProvider> {
  const wanted = typeof name === "string" && name.length > 0 ? name : "local";
  if (wanted === "local") {
    localRuntime ??= createLocalOpRuntime({ projectPath: resolve(".") });
    return localRuntime;
  }

  const configured = await loadChantConfig(resolve("."))
    .then(({ config }) => config.lexicons ?? [])
    .catch(() => [] as string[]);
  if (!configured.includes(wanted)) {
    throw new Error(
      `runtime "${wanted}" is not a configured lexicon` +
        (configured.length > 0 ? ` (configured: ${configured.join(", ")})` : ""),
    );
  }
  const plugin = (await loadPlugins([wanted]))[0];
  if (!plugin?.opRuntime) throw new Error(`lexicon "${wanted}" does not host Op runs`);
  return plugin.opRuntime;
}

const RUNTIME_PARAM = {
  type: "string",
  description: 'Runtime to address: a lexicon name with an opRuntime, or "local" (the default)',
} as const;

export function createOpListTool(): ToolRegistration {
  return {
    definition: {
      name: "op-list",
      description: "List all Op definitions discovered from *.op.ts files with their current run state",
      inputSchema: {
        type: "object",
        properties: {
          runtime: RUNTIME_PARAM,
        },
      },
    },
    handler: async (params) => {
      const { ops, errors } = await discoverOps();

      let states: Map<string, { state: string } | undefined> = new Map();
      try {
        const runtime = await runtimeFor(params.runtime);
        states = await runtime.list([...ops.values()].map((d) => d.config));
      } catch {
        // Runtime unavailable — the definitions are still worth listing.
      }

      const result = [];
      for (const [name, { config }] of ops) {
        result.push({
          name,
          overview: config.overview,
          phases: config.phases.length,
          depends: config.depends ?? [],
          runState: states.get(name)?.state ?? "—",
        });
      }

      return { ops: result, errors };
    },
  };
}

export function createOpRunTool(): ToolRegistration {
  return {
    definition: {
      name: "op-run",
      description:
        "Run an Op on a runtime and return its result. Defaults to the built-in local runtime, which executes the Op in this process.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          runtime: RUNTIME_PARAM,
        },
        required: ["name"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;

      const { ops } = await discoverOps();
      if (!ops.has(name)) {
        const available = [...ops.keys()];
        return `Op "${name}" not found. Available: ${available.join(", ") || "none"}`;
      }

      const runtime = await runtimeFor(params.runtime);
      const handle = await runtime.start(ops.get(name)!.config, {});
      const status = await handle.result();

      return {
        op: status.op,
        runId: status.runId,
        state: status.state,
        startedAt: status.startedAt,
        endedAt: status.endedAt ?? null,
        ...(status.records ? { records: status.records } : {}),
        ...(status.gate ? { gate: status.gate } : {}),
      };
    },
  };
}

export function createOpStatusTool(): ToolRegistration {
  return {
    definition: {
      name: "op-status",
      description: "Return the current run state of an Op on a runtime",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          runtime: RUNTIME_PARAM,
        },
        required: ["name"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;

      const { ops } = await discoverOps();
      if (!ops.has(name)) throw new Error(`Op "${name}" not found`);

      const runtime = await runtimeFor(params.runtime);
      const status = await runtime.status(name);
      if (!status) return { op: name, runtime: runtime.name, state: null, message: "no run recorded" };

      return {
        op: status.op,
        runtime: runtime.name,
        runId: status.runId,
        state: status.state,
        startedAt: status.startedAt,
        endedAt: status.endedAt ?? null,
        ...(status.records ? { records: status.records } : {}),
        gate: status.gate ?? null,
      };
    },
  };
}

export function createOpApproveTool(): ToolRegistration {
  return {
    definition: {
      name: "op-approve",
      description:
        "Record a gate's resolution on the gate ledger and wake the runtime hosting the gated run. The rename of op-signal: a gate is resolved by recording the fact, not by sending a message.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          gate: { type: "string", description: "Gate name (e.g. gate-dns-delegation)" },
          approver: { type: "string", description: "Who approved; defaults to the CI or shell identity" },
          note: { type: "string", description: "Free-text context recorded on the resolution" },
          url: { type: "string", description: "Absolute http/https URL this resolution happened at" },
          runtime: RUNTIME_PARAM,
        },
        required: ["name", "gate"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;
      const gate = params.gate as string;
      if (!name || !gate) throw new Error("op-approve needs both an Op name and a gate name");

      const runtime = await runtimeFor(params.runtime);
      const outcome = await recordGateApproval(name, gate, {
        actor: params.approver as string | undefined,
        note: params.note as string | undefined,
        url: params.url as string | undefined,
      });
      if (!outcome.ok) throw new Error(`Gate "${gate}" on "${name}" was not recorded`);

      if (runtime.resolveGate) await runtime.resolveGate(name, gate, outcome.record);

      return {
        op: name,
        gate,
        resolvedBy: outcome.record.resolvedBy,
        timestamp: outcome.record.timestamp,
        runtimeNotified: Boolean(runtime.resolveGate),
      };
    },
  };
}

export function createOpReportTool(): ToolRegistration {
  return {
    definition: {
      name: "op-report",
      description: "Return a markdown report for the latest run of an Op on a runtime",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          runtime: RUNTIME_PARAM,
        },
        required: ["name"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;

      const { ops } = await discoverOps();
      if (!ops.has(name)) return `Op "${name}" not found`;
      const { config } = ops.get(name)!;

      const runtime = await runtimeFor(params.runtime);
      const status = await runtime.status(name);
      if (!status) return `# ${name}\n\n${config.overview}\n\nNo run is recorded on the "${runtime.name}" runtime.\n`;

      const lines = [
        `# ${name}`,
        "",
        config.overview,
        "",
        `- Runtime: ${runtime.name}`,
        `- Run: ${status.runId}`,
        `- State: ${status.state}`,
        `- Started: ${status.startedAt}`,
        ...(status.endedAt ? [`- Ended: ${status.endedAt}`] : []),
        ...(status.gate ? [`- Gate: ${status.gate.name} (pending since ${status.gate.since})`] : []),
        "",
      ];

      if (status.records?.length) {
        lines.push("| Phase | Step | Status | Duration |", "|---|---|---|---|");
        for (const record of status.records) {
          lines.push(`| ${record.phase} | ${record.fn} | ${record.status} | ${record.durationMs}ms |`);
        }
        lines.push("");
      }

      return lines.join("\n");
    },
  };
}
