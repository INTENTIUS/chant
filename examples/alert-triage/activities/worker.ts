// The Temporal worker — registers the triage activities and workflow, and
// connects using the `local` profile from chant.config.ts. Run it locally
// against `temporal server start-dev`:
//
//   npx tsx activities/worker.ts
import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import * as activities from "./triage";
import chantConfig from "../chant.config.js";

async function run(): Promise<void> {
  const profileName = process.env.TEMPORAL_PROFILE ?? chantConfig.temporal.defaultProfile ?? "local";
  const profile = chantConfig.temporal.profiles[profileName];
  if (!profile) {
    throw new Error(`Unknown Temporal profile "${profileName}"`);
  }

  const connection = await NativeConnection.connect({ address: profile.address });
  try {
    const worker = await Worker.create({
      connection,
      namespace: profile.namespace,
      taskQueue: profile.taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
      activities,
    });
    console.log(`alert-triage worker polling ${profile.taskQueue} on ${profile.address}`);
    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
