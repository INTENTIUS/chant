/**
 * A throwaway Postgres server for the live tests: the pinned image on a random
 * loopback port, a client for it, and a URL for a second database on it.
 * Always removed with its volume.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startScratchContainer } from "../../core/container";
import { postgresImage, POSTGRES_LATEST_MAJOR } from "../../spec/postgres-pin";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../live/client";

export { dockerAvailable } from "../../core/container";

export interface TestPostgres {
  name: string;
  /** The endpoint of database `db` (default `postgres`). */
  endpoint(db?: string): PostgresEndpoint;
  /** A client on database `db`, with the catalog-reading session (empty search_path). */
  connect(db?: string): Promise<PostgresClient>;
  stop(): Promise<void>;
}

const PASSWORD = "chant";
const exec = promisify(execFile);

export async function startTestPostgres(major = POSTGRES_LATEST_MAJOR): Promise<TestPostgres> {
  let port = "";
  let name = "";
  const endpoint = (db = "postgres"): PostgresEndpoint => ({ url: `postgres://postgres@127.0.0.1:${port}/${db}`, password: PASSWORD });
  const container = await startScratchContainer({
    image: postgresImage(major),
    namePrefix: "chant-sql-pg-test",
    containerPort: 5432,
    env: { POSTGRES_PASSWORD: PASSWORD },
    removeVolumes: true,
    readyTimeoutMs: 120_000,
    notReady: "did not accept a connection",
    onStarted: (n: string) => {
      name = n;
    },
    ready: async (p) => {
      port = p;
      // The image runs a temporary server for initdb and then restarts it: ready is the second "ready" line.
      const logs = await exec("docker", ["logs", name]).then((r) => `${r.stdout}${r.stderr}`, () => "");
      if ((logs.match(/database system is ready to accept connections/g) ?? []).length < 2) return false;
      try {
        const c = await connectPostgres(endpoint());
        await c.query("SELECT 1");
        await c.end();
        return true;
      } catch {
        return false;
      }
    },
  });
  return { name: container.name, endpoint, connect: (db) => connectPostgres(endpoint(db)), stop: () => container.stop() };
}
