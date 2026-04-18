import { resolve } from "node:path";
import { discoverOps } from "../../op/discover";
import { makeTemporalClient } from "../handlers/run";
import { resolveWorkflowId } from "../handlers/run-client";
import { generateReport } from "../handlers/run-report";
import type { ToolRegistration } from "./state-tools";

function workflowFnName(opName: string): string {
  return opName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) + "Workflow";
}

export function createOpListTool(): ToolRegistration {
  return {
    definition: {
      name: "op-list",
      description: "List all Op definitions discovered from *.op.ts files with their current run status",
      inputSchema: {
        type: "object",
        properties: {
          profile: { type: "string", description: "Temporal profile name from chant.config.ts (optional)" },
        },
      },
    },
    handler: async (params) => {
      const { ops, errors } = await discoverOps();
      const profile = params.profile as string | undefined;

      let client: Awaited<ReturnType<typeof makeTemporalClient>>["client"] | undefined;
      try {
        ({ client } = await makeTemporalClient(profile, resolve(".")));
      } catch {
        // Temporal not available — degrade gracefully
      }

      const result = [];
      for (const [name, { config }] of ops) {
        let runStatus = "—";
        if (client) {
          try {
            const desc = await client.workflow.getHandle(resolveWorkflowId(name)).describe();
            runStatus = desc.status.name;
          } catch {
            // workflow not found or Temporal error
          }
        }
        result.push({
          name,
          overview: config.overview,
          phases: config.phases.length,
          taskQueue: config.taskQueue ?? config.name,
          depends: config.depends ?? [],
          runStatus,
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
        "Submit an Op workflow to Temporal. The worker must already be running — start it first with `chant run <name>`.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          profile: { type: "string", description: "Temporal profile name from chant.config.ts (optional)" },
        },
        required: ["name"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;
      const profile = params.profile as string | undefined;

      const { ops } = await discoverOps();
      if (!ops.has(name)) {
        const available = [...ops.keys()];
        return `Op "${name}" not found. Available: ${available.join(", ") || "none"}`;
      }

      const { config } = ops.get(name)!;
      const { client, profile: resolvedProfile } = await makeTemporalClient(profile, resolve("."));
      const workflowId = resolveWorkflowId(name);
      const taskQueue = resolvedProfile.taskQueue ?? config.taskQueue ?? name;

      await client.workflow.start(workflowFnName(name), {
        taskQueue,
        workflowId,
        workflowIdConflictPolicy: "FAIL",
      });

      return { workflowId, message: `Workflow "${workflowId}" submitted to task queue "${taskQueue}"` };
    },
  };
}

export function createOpStatusTool(): ToolRegistration {
  return {
    definition: {
      name: "op-status",
      description: "Return the current run state of an Op workflow",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          profile: { type: "string", description: "Temporal profile name from chant.config.ts (optional)" },
        },
        required: ["name"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;
      const profile = params.profile as string | undefined;

      const { client } = await makeTemporalClient(profile, resolve("."));
      const handle = client.workflow.getHandle(resolveWorkflowId(name));
      const desc = await handle.describe();
      const history = await handle.fetchHistory();

      const events = history.events ?? [];
      const activitiesCompleted = events.filter((e) => e.eventType === "ActivityTaskCompleted").length;
      const activitiesScheduled = events.filter((e) => e.eventType === "ActivityTaskScheduled").length;

      return {
        workflowId: desc.workflowId,
        runId: desc.runId,
        status: desc.status.name,
        startTime: desc.startTime,
        closeTime: desc.closeTime ?? null,
        taskQueue: desc.taskQueue,
        activitiesCompleted,
        activitiesScheduled,
      };
    },
  };
}

export function createOpSignalTool(): ToolRegistration {
  return {
    definition: {
      name: "op-signal",
      description: "Send a named signal to an Op workflow (e.g. to unblock a gate step)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          signal: { type: "string", description: "Signal name (e.g. gate-dns-delegation)" },
          profile: { type: "string", description: "Temporal profile name from chant.config.ts (optional)" },
        },
        required: ["name", "signal"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;
      const signal = params.signal as string;
      const profile = params.profile as string | undefined;

      const { client } = await makeTemporalClient(profile, resolve("."));
      const handle = client.workflow.getHandle(resolveWorkflowId(name));
      await handle.signal(signal);

      return `Signal "${signal}" sent to Op "${name}"`;
    },
  };
}

export function createOpReportTool(): ToolRegistration {
  return {
    definition: {
      name: "op-report",
      description: "Return a markdown deployment report for the latest run of an Op",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Op name (e.g. alb-deploy)" },
          profile: { type: "string", description: "Temporal profile name from chant.config.ts (optional)" },
        },
        required: ["name"],
      },
    },
    handler: async (params) => {
      const name = params.name as string;
      const profile = params.profile as string | undefined;

      const { ops } = await discoverOps();
      if (!ops.has(name)) {
        return `Op "${name}" not found`;
      }
      const { config } = ops.get(name)!;

      const { client } = await makeTemporalClient(profile, resolve("."));
      const handle = client.workflow.getHandle(resolveWorkflowId(name));
      const desc = await handle.describe();
      const history = await handle.fetchHistory();

      return generateReport(name, config, desc, history);
    },
  };
}
