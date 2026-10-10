/**
 * The sql lexicon's Postgres emulator capability (#3280): the official
 * `postgres` image at the newest pin, by tag and digest (../../spec/postgres-pin.ts),
 * the same server generation and the live tests run, so `chant emulator up`
 * boots a real Postgres rather than a stand-in.
 *
 * Postgres has no HTTP health endpoint, so readiness is `pg_isready` run in
 * the container against 127.0.0.1: the image's first, initdb-time server
 * listens on its socket only, so the TCP check answers once the real server
 * is up. The endpoint is a `postgres://` URL, which `POSTGRES_URL` carries;
 * the user and password are `POSTGRES_USER` and `POSTGRES_PASSWORD`, the
 * variables binding reads with it.
 *
 * `upstream` is left off: the pins move per major through the lexicon's
 * `upstreamPins`, not the emulator freshness check.
 */

import { emulatorLifecycle, type EmulatorCapability, type EmulatorIdentity, type EmulatorSpec } from "@intentius/chant/op";
import { POSTGRES_LATEST_MAJOR, postgresImage } from "../../spec/postgres-pin";
import { connectPostgres } from "../../postgres/live/client";

/** The local server's password. It is a throwaway server on localhost. */
export const POSTGRES_EMULATOR_PASSWORD = "chant";

/** How long `chant emulator status` waits for the server behind the endpoint. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * The cluster's system identifier, unique per `initdb` (#3673): read in the
 * container over its socket, and through the endpoint `status` prints. A
 * native Postgres holding 127.0.0.1:5432 answers with its own, or refuses
 * the emulator's sign-in.
 */
export const POSTGRES_EMULATOR_IDENTITY: EmulatorIdentity = {
  server: "Postgres",
  command: ["psql", "-U", "postgres", "-tAc", "select system_identifier from pg_control_system()"],
  async probe(endpoint) {
    const client = await withTimeout(
      connectPostgres({ url: endpoint, user: "postgres", password: POSTGRES_EMULATOR_PASSWORD }, { applicationName: "chant emulator status" }),
    );
    try {
      const [row] = await withTimeout(
        client.query<{ id: string; version: string }>(
          "SELECT system_identifier::text AS id, pg_catalog.current_setting('server_version') AS version FROM pg_catalog.pg_control_system()",
        ),
      );
      return { id: row?.id ?? "", label: `PostgreSQL ${row?.version ?? "(unknown version)"}` };
    } finally {
      await client.end();
    }
  },
};

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const POSTGRES_EMULATOR_SPEC: EmulatorSpec = {
  name: "chant-postgres",
  image: postgresImage(POSTGRES_LATEST_MAJOR),
  containerPort: 5432,
  readyCommand: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
  endpoint: (port) => `postgres://localhost:${port}/postgres`,
  runArgs: ["-e", `POSTGRES_PASSWORD=${POSTGRES_EMULATOR_PASSWORD}`],
  identity: POSTGRES_EMULATOR_IDENTITY,
  credentials: `user postgres, password ${POSTGRES_EMULATOR_PASSWORD}`,
};

/** `POSTGRES_URL` is the variable binding reads when no `sql.profiles.<env>` names a server. */
export const POSTGRES_EMULATOR: EmulatorCapability = {
  spec: POSTGRES_EMULATOR_SPEC,
  env: (endpoint) => ({ POSTGRES_URL: endpoint, POSTGRES_USER: "postgres", POSTGRES_PASSWORD: POSTGRES_EMULATOR_PASSWORD }),
};

const lifecycle = emulatorLifecycle(POSTGRES_EMULATOR_SPEC);

/** Boot the pinned Postgres server in Docker and return its endpoint. */
export const postgresUp = (args: Parameters<typeof lifecycle.up>[0] = {}, signal?: AbortSignal) => lifecycle.up(args, signal);
/** Stop and remove it (a no-op when it is gone). */
export const postgresDown = (args: { name?: string } = {}, signal?: AbortSignal) => lifecycle.down(args, signal);
