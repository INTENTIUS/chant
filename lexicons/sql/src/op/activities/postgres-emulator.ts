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

import { emulatorLifecycle, type EmulatorCapability, type EmulatorSpec } from "@intentius/chant/op";
import { POSTGRES_LATEST_MAJOR, postgresImage } from "../../spec/postgres-pin";

/** The local server's password. It is a throwaway server on localhost. */
export const POSTGRES_EMULATOR_PASSWORD = "chant";

export const POSTGRES_EMULATOR_SPEC: EmulatorSpec = {
  name: "chant-postgres",
  image: postgresImage(POSTGRES_LATEST_MAJOR),
  containerPort: 5432,
  readyCommand: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
  endpoint: (port) => `postgres://localhost:${port}/postgres`,
  runArgs: ["-e", `POSTGRES_PASSWORD=${POSTGRES_EMULATOR_PASSWORD}`],
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
