// Temporal client helper — start a triage workflow for an alert. Shared by both
// event sources (the webhook and the drift source).
import { Connection, Client } from "@temporalio/client";
import chantConfig from "../chant.config.js";
import type { Alert } from "../activities/triage";

export async function startTriage(alert: Alert): Promise<string> {
  const profileName = process.env.TEMPORAL_PROFILE ?? chantConfig.temporal.defaultProfile ?? "local";
  const profile = chantConfig.temporal.profiles[profileName];
  if (!profile) throw new Error(`Unknown Temporal profile "${profileName}"`);

  const connection = await Connection.connect({ address: profile.address });
  try {
    const client = new Client({ connection, namespace: profile.namespace });
    const workflowId = `alert-triage-${alert.id}-${Date.now()}`;
    await client.workflow.start("alertTriage", {
      taskQueue: profile.taskQueue,
      workflowId,
      args: [alert],
    });
    return workflowId;
  } finally {
    await connection.close();
  }
}
