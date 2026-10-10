/**
 * The sql lexicon's emulator capability (#3208): the pinned
 * `clickhouse/clickhouse-server`, the same image and digest generation and
 * the live tests run (../../spec/pin.ts), so `chant emulator up` boots a real
 * server rather than a stand-in.
 *
 * `upstream` is left off on purpose. The freshness check compares the image
 * tag against the repo's latest GitHub release, and ClickHouse's latest
 * release is a monthly one, not the LTS line the pin follows; the lexicon's
 * `upstreamPin` already tracks the LTS tags (`-lts`).
 */

import { emulatorLifecycle, type EmulatorCapability, type EmulatorIdentity, type EmulatorSpec } from "@intentius/chant/op";
import { clickhouseImage } from "../../spec/pin";

/**
 * The server's UUID (#3673), read in the container and through the endpoint
 * `status` prints, so a server of another origin on the same port is told
 * apart from the emulator.
 */
export const CLICKHOUSE_EMULATOR_IDENTITY: EmulatorIdentity = {
  server: "ClickHouse",
  command: ["clickhouse-client", "-q", "SELECT serverUUID()"],
  async probe(endpoint) {
    const url = new URL(endpoint);
    url.searchParams.set("query", "SELECT serverUUID(), version() FORMAT TSV");
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.text()).trim();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.split("\n")[0]}`);
    const [id = "", version = "(unknown version)"] = body.split("\t");
    return { id, label: `ClickHouse ${version}` };
  },
};

export const CLICKHOUSE_EMULATOR_SPEC: EmulatorSpec = {
  name: "chant-clickhouse",
  image: clickhouseImage(),
  containerPort: 8123,
  healthPath: "/ping",
  // The image disables network access for the passwordless default user
  // unless this is set; a local server is reached as `default` with no password.
  runArgs: ["-e", "CLICKHOUSE_SKIP_USER_SETUP=1"],
  identity: CLICKHOUSE_EMULATOR_IDENTITY,
  credentials: "user default, no password",
};

/** `CLICKHOUSE_URL` is the variable binding reads when no `sql.profiles.<env>` names a server. */
export const CLICKHOUSE_EMULATOR: EmulatorCapability = {
  spec: CLICKHOUSE_EMULATOR_SPEC,
  env: (endpoint) => ({ CLICKHOUSE_URL: endpoint }),
};

const lifecycle = emulatorLifecycle(CLICKHOUSE_EMULATOR_SPEC);

/** Boot the pinned ClickHouse server in Docker and return its endpoint. */
export const clickhouseUp = (args: Parameters<typeof lifecycle.up>[0] = {}, signal?: AbortSignal) => lifecycle.up(args, signal);
/** Stop and remove it (a no-op when it is gone). */
export const clickhouseDown = (args: { name?: string } = {}, signal?: AbortSignal) => lifecycle.down(args, signal);
