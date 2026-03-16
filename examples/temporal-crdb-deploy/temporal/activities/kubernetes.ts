import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Context } from '@temporalio/activity';
import type { DeployParams, Region } from '../types.js';
import { REGION_CONFIG } from '../types.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');

function env(params: DeployParams): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GCP_PROJECT_ID: params.gcpProjectId,
    CRDB_DOMAIN: params.crdbDomain,
  };
}

export async function configureKubectl(params: DeployParams): Promise<void> {
  for (const [region, { gkeCluster, gkeRegion }] of Object.entries(REGION_CONFIG) as Array<[Region, typeof REGION_CONFIG[Region]]>) {
    await execAsync(
      `gcloud container clusters get-credentials ${gkeCluster} --region ${gkeRegion} --project ${params.gcpProjectId}`,
      { cwd: ROOT_DIR, env: env(params) },
    );
    const { stdout: currentCtx } = await execAsync('kubectl config current-context', {
      env: env(params),
    });
    // Delete any stale context from a prior run before renaming
    await execAsync(`kubectl config delete-context ${region}`, { env: env(params) }).catch(() => {});
    await execAsync(
      `kubectl config rename-context "${currentCtx.trim()}" ${region}`,
      { env: env(params) },
    );
    console.log(`kubectl context configured for ${region}`);
  }
}

export async function applyK8sManifests(params: DeployParams, region: Region): Promise<void> {
  const { stdout } = await execAsync(
    `kubectl --context ${region} apply -f dist/${region}-k8s.yaml`,
    { cwd: ROOT_DIR, env: env(params) },
  );
  console.log(stdout.trim());
}

/**
 * Waits for ExternalDNS to register pod IPs as A records in the crdb.internal private zone.
 * Heartbeats every iteration so the 60 s heartbeatTimeout is never exceeded.
 */
export async function waitForExternalDNS(params: DeployParams): Promise<void> {
  const ctx = Context.current();

  // Poll until ExternalDNS Deployment has readyReplicas ≥ 1 on each cluster
  for (const region of ['east', 'central', 'west'] as const) {
    for (let attempt = 1; attempt <= 24; attempt++) {
      ctx.heartbeat({ phase: 'external-dns rollout', region, attempt });
      const { stdout } = await execAsync(
        `kubectl --context ${region} -n kube-system get deployment/external-dns -o jsonpath='{.status.readyReplicas}'`,
        { cwd: ROOT_DIR, env: env(params) },
      ).catch(() => ({ stdout: '' }));
      if (Number(stdout.trim()) >= 1) {
        console.log(`external-dns ready on ${region}`);
        break;
      }
      if (attempt === 24) throw new Error(`external-dns not ready in ${region} after 4 min`);
      await sleep(10_000);
    }
  }

  // Poll for at least 9 A records in crdb.internal (3 nodes × 3 regions)
  for (let attempt = 1; attempt <= 30; attempt++) {
    ctx.heartbeat({ phase: 'waiting for DNS A records', attempt });

    const { stdout } = await execAsync(
      `gcloud dns record-sets list --zone=crdb-internal --project ${params.gcpProjectId}` +
        ` --filter="type=A" --format="value(name)"`,
      { cwd: ROOT_DIR, env: env(params) },
    ).catch(() => ({ stdout: '' }));

    const count = stdout.trim().split('\n').filter(Boolean).length;
    console.log(`crdb.internal A records: ${count} (need ≥9)`);

    if (count >= 9) return;

    if (attempt === 30) {
      console.warn(`Only ${count} A records after 5 min — check ExternalDNS logs. Continuing.`);
      return;
    }
    await sleep(10_000);
  }
}

/**
 * Waits for the CockroachDB StatefulSet to finish rolling out in the given region.
 * Heartbeats every 15 s so the 60 s heartbeatTimeout is never exceeded.
 */
export async function waitForStatefulSets(params: DeployParams, region: Region): Promise<void> {
  const ctx = Context.current();
  const { namespace } = REGION_CONFIG[region];

  for (let attempt = 1; attempt <= 40; attempt++) {
    ctx.heartbeat({ phase: 'waiting for StatefulSet', region, attempt });
    const { stdout } = await execAsync(
      `kubectl --context ${region} -n ${namespace} get statefulset/cockroachdb -o jsonpath='{.status.readyReplicas}'`,
      { cwd: ROOT_DIR, env: env(params) },
    ).catch(() => ({ stdout: '' }));
    if (Number(stdout.trim()) >= 3) {
      console.log(`cockroachdb StatefulSet ready in ${region}`);
      return;
    }
    if (attempt === 40) throw new Error(`cockroachdb StatefulSet not ready in ${region} after 10 min`);
    await sleep(15_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
