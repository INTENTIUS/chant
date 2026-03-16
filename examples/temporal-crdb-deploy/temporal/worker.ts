/**
 * Temporal worker — connects to Temporal Cloud and registers the deploy workflow
 * with all four activity groups.
 *
 * Required env vars:
 *   TEMPORAL_ADDRESS    — e.g. myns.a2dd6.tmprl.cloud:7233
 *   TEMPORAL_NAMESPACE  — e.g. myns.a2dd6
 *   TEMPORAL_API_KEY    — Temporal Cloud API key (Settings → API Keys)
 *
 * Run: npm run temporal:worker
 */
import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'url';

import * as infraActivities from './activities/infra.js';
import * as k8sActivities from './activities/kubernetes.js';
import * as crdbActivities from './activities/cockroachdb.js';
import * as certsActivities from './activities/certs.js';

async function run(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS;
  const namespace = process.env.TEMPORAL_NAMESPACE;
  const apiKey = process.env.TEMPORAL_API_KEY;

  if (!address || !namespace || !apiKey) {
    console.error(
      'Missing required env vars: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY\n' +
        'Set them in .env and source it: set -a && source .env && set +a',
    );
    process.exit(1);
  }

  console.log(`Connecting to Temporal Cloud: ${address} (namespace: ${namespace})`);

  const connection = await NativeConnection.connect({
    address,
    tls: {},
    metadata: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: 'crdb-deploy',
    // `@temporalio/worker` ships its own TypeScript loader — .ts workflow files
    // are bundled into Temporal's deterministic V8 sandbox automatically.
    workflowsPath: fileURLToPath(new URL('./workflows/deploy.ts', import.meta.url)),
    activities: {
      ...infraActivities,
      ...k8sActivities,
      ...crdbActivities,
      ...certsActivities,
    },
  });

  console.log('Worker ready — polling task queue: crdb-deploy');
  await worker.run();
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
