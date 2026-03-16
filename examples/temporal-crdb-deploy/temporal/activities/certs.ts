import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { DeployParams, Region } from '../types.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');

function env(params: DeployParams): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GCP_PROJECT_ID: params.gcpProjectId,
    CRDB_DOMAIN: params.crdbDomain,
    CERTS_DIR: params.certsDir ?? './certs',
  };
}

export async function generateAndDistributeCerts(params: DeployParams): Promise<void> {
  // Fail fast if Docker is not running — the cert-gen script uses Docker
  await execAsync('docker info').catch(() => {
    throw new Error('Docker is not running — start Docker Desktop, then retry.');
  });

  const { stdout, stderr } = await execAsync('bash scripts/generate-certs.sh', {
    cwd: ROOT_DIR,
    env: env(params),
  });
  if (stdout) console.log(stdout.trim());
  if (stderr) console.warn(stderr.trim());
}

export async function installESO(params: DeployParams, region: Region): Promise<void> {
  await execAsync(
    'helm repo add external-secrets https://charts.external-secrets.io 2>/dev/null || true' +
      ' && helm repo update external-secrets',
    { cwd: ROOT_DIR, env: env(params) },
  );

  const { stdout } = await execAsync(
    [
      'helm upgrade --install external-secrets external-secrets/external-secrets',
      `--kube-context ${region}`,
      '--namespace kube-system',
      '--set installCRDs=true',
      '--wait --timeout 300s',
    ].join(' '),
    { cwd: ROOT_DIR, env: env(params) },
  );
  console.log(`ESO installed on ${region}:`, stdout.trim());
}

export async function pushSecretsToSecretManager(params: DeployParams): Promise<void> {
  const certsDir = params.certsDir ?? './certs';
  const project = params.gcpProjectId;

  const secrets: Array<[string, string]> = [
    ['crdb-ca-crt',          `${certsDir}/ca.crt`],
    ['crdb-node-crt',        `${certsDir}/node.crt`],
    ['crdb-node-key',        `${certsDir}/node.key`],
    ['crdb-client-root-crt', `${certsDir}/client.root.crt`],
    ['crdb-client-root-key', `${certsDir}/client.root.key`],
  ];

  for (const [secretName, dataFile] of secrets) {
    // Ensure the secret exists first (idempotent create), then append a new version
    await execAsync(
      `gcloud secrets create ${secretName} --project ${project} --replication-policy automatic 2>/dev/null || true`,
      { cwd: ROOT_DIR, env: env(params) },
    );
    await execAsync(
      `gcloud secrets versions add ${secretName} --data-file=${dataFile} --project ${project}`,
      { cwd: ROOT_DIR, env: env(params) },
    ); // no catch — failures must surface so ESO sync isn't silently broken
  }
  console.log('TLS certificates pushed to Secret Manager');
}
