/**
 * Temporal worker — connects to Temporal Cloud and registers the deploy workflow
 * with all four activity groups.
 *
 * Connection config is sourced from chant.config.ts (a TypeScript-typed profile),
 * not raw env vars. This makes misconfigured workers a compile error, not a runtime
 * failure 5 minutes into a deployment.
 *
 * Run: npm run temporal:worker
 */
import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'url';

import * as infraActivities from './activities/infra.js';
import * as k8sActivities from './activities/kubernetes.js';
import * as crdbActivities from './activities/cockroachdb.js';
import * as certsActivities from './activities/certs.js';

import chantConfig from '../chant.config.ts';

async function run(): Promise<void> {
  const profileName = process.env.TEMPORAL_PROFILE ?? chantConfig.temporal.defaultProfile ?? 'cloud';
  const profile = chantConfig.temporal.profiles[profileName];

  if (!profile) {
    console.error(`Unknown Temporal profile "${profileName}". Available: ${Object.keys(chantConfig.temporal.profiles).join(', ')}`);
    process.exit(1);
  }

  // Resolve API key — either a literal string or an env var reference.
  const apiKey = typeof profile.apiKey === 'object' && profile.apiKey !== null
    ? process.env[(profile.apiKey as { env: string }).env]
    : profile.apiKey as string | undefined;

  if (profile.tls && !apiKey) {
    console.error(
      `Profile "${profileName}" requires an API key.\n` +
      `Set TEMPORAL_API_KEY in .env: set -a && source .env && set +a`,
    );
    process.exit(1);
  }

  console.log(`Connecting to Temporal (profile: ${profileName}): ${profile.address} (namespace: ${profile.namespace})`);

  const connection = await NativeConnection.connect({
    address: profile.address,
    ...(profile.tls && {
      tls: typeof profile.tls === 'object' ? profile.tls : {},
      metadata: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }),
  });

  const worker = await Worker.create({
    connection,
    namespace: profile.namespace,
    taskQueue: profile.taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflows/deploy.ts', import.meta.url)),
    activities: {
      ...infraActivities,
      ...k8sActivities,
      ...crdbActivities,
      ...certsActivities,
    },
  });

  console.log(`Worker ready — polling task queue: ${profile.taskQueue}`);
  await worker.run();
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
