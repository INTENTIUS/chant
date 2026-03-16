import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { DeployParams } from '../types.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');

// The CockroachDbCluster composite mounts two cert directories into each pod:
//   /cockroach/cockroach-certs       — node certs (ca.crt, node.crt, node.key)
//   /cockroach/cockroach-client-certs — client certs (ca.crt, client.root.crt, client.root.key)
// cockroach start uses --certs-dir=/cockroach/cockroach-certs (node certs).
// cockroach init / sql / backup use --certs-dir=/cockroach/cockroach-client-certs.
const CLIENT_CERTS_DIR = '/cockroach/cockroach-client-certs';

function env(params: DeployParams): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GCP_PROJECT_ID: params.gcpProjectId,
    CRDB_DOMAIN: params.crdbDomain,
  };
}

export async function initializeCockroachDB(params: DeployParams): Promise<void> {
  const { stdout, stderr } = await execAsync(
    `kubectl --context east exec cockroachdb-0 -n crdb-east --` +
      ` /cockroach/cockroach init --certs-dir=${CLIENT_CERTS_DIR}`,
    { cwd: ROOT_DIR, env: env(params) },
  ).catch((err: Error & { stderr?: string }) => {
    // "already initialized" is success — cluster formed before init was called
    if (err.message?.includes('already been initialized') ||
        err.stderr?.includes('already been initialized')) {
      return { stdout: 'Cluster already initialized', stderr: '' };
    }
    throw err;
  });
  if (stdout) console.log(stdout.trim());
  if (stderr) console.warn(stderr.trim());
}

export async function configureMultiRegion(params: DeployParams): Promise<void> {
  const { stdout, stderr } = await execAsync('bash scripts/configure-regions.sh', {
    cwd: ROOT_DIR,
    env: env(params),
  });
  if (stdout) console.log(stdout.trim());
  if (stderr) console.warn(stderr.trim());
}

export async function setupBackupSchedule(params: DeployParams): Promise<void> {
  const sql = [
    "CREATE SCHEDULE IF NOT EXISTS 'daily-full-backup'",
    `  FOR BACKUP INTO 'gs://${params.gcpProjectId}-crdb-backups/full?AUTH=implicit'`,
    "  RECURRING '@daily'",
    "  WITH SCHEDULE OPTIONS first_run = 'now';",
  ].join(' ');

  const { stdout } = await execAsync(
    `kubectl --context east exec cockroachdb-0 -n crdb-east --` +
      ` /cockroach/cockroach sql --certs-dir=${CLIENT_CERTS_DIR} -e "${sql}"`,
    { cwd: ROOT_DIR, env: env(params) },
  );
  console.log(stdout.trim());
}
