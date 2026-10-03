/**
 * A throwaway `clickhouse-server` in a container: started on a random loopback
 * port under a unique name, and always removed (the shared core's
 * `../core/container.ts`, ready when it answers `/ping`).
 *
 * Generation uses it on a pin move to read the pinned server's catalog. The
 * live tests use the same helper so every container chant starts is started
 * and cleaned up one way. A cluster of replicas with embedded Keeper is
 * ClickHouse's own.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { clickhousePing, clickhouseQuery, type ClickHouseEndpoint } from "./http";
import { publishedPort, startScratchContainer, uniqueContainerName } from "../core/container";

export { dockerAvailable } from "../core/container";

const exec = promisify(execFile);

export interface ScratchServer {
  endpoint: ClickHouseEndpoint;
  /** The container's name, for a log line. */
  name: string;
  /** Remove the container. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Start `image` and wait until it answers `/ping`. Pulls the image when it is
 * not present, which is the one network step here.
 */
export async function startScratchServer(
  image: string,
  options: { namePrefix?: string; readyTimeoutMs?: number } = {},
): Promise<ScratchServer> {
  const endpointOf = (port: string): ClickHouseEndpoint => ({ url: `http://127.0.0.1:${port}` });
  const c = await startScratchContainer({
    image,
    namePrefix: options.namePrefix ?? "chant-sql",
    containerPort: 8123,
    env: { CLICKHOUSE_SKIP_USER_SETUP: "1" },
    ready: (port) => clickhousePing(endpointOf(port)),
    readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
    notReady: "did not answer /ping",
  });
  return { endpoint: endpointOf(c.port), name: c.name, stop: c.stop };
}

export interface ScratchCluster {
  /** One endpoint per replica, in replica order (`r1`, `r2`, ...). */
  replicas: ClickHouseEndpoint[];
  /** The containers' common name prefix, for a log line. */
  name: string;
  /** Remove the containers and their network. Safe to call twice. */
  stop(): Promise<void>;
  /**
   * Stop one replica's container (`docker stop`, by index into `replicas`),
   * keeping its data. The first replica runs Keeper, so stopping it stops
   * the cluster's Keeper too.
   */
  stopReplica(index: number): Promise<void>;
  /**
   * Start a stopped replica again and wait until it answers and reaches
   * Keeper. Docker gives it a new host port, so `replicas[index]` is
   * replaced with its new endpoint, which is also returned.
   */
  startReplica(index: number): Promise<ClickHouseEndpoint>;
}

/**
 * Start `replicas` servers of `image` as one shard of replicas, on their own
 * Docker network, and wait until each answers and reaches Keeper.
 *
 * Keeper is the server's embedded one (`keeper_server`), run by the first
 * replica, so the pinned server image and its digest pin Keeper too. Each
 * replica gets the macros `{shard}` = `s1` and `{replica}` = `r<n>`, which
 * a `Replicated` database's arguments name. Configuration is copied into each
 * container before it starts, with no bind mount.
 */
export async function startScratchCluster(
  image: string,
  options: { replicas?: number; namePrefix?: string; readyTimeoutMs?: number } = {},
): Promise<ScratchCluster> {
  const count = options.replicas ?? 2;
  const name = uniqueContainerName(options.namePrefix ?? "chant-sql-cluster");
  const network = `${name}-net`;
  const nodes = Array.from({ length: count }, (_, i) => `${name}-r${i + 1}`);
  const dir = mkdtempSync(join(tmpdir(), "chant-sql-cluster-"));
  let removed = false;
  const stop = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await exec("docker", ["rm", "-f", ...nodes]).catch(() => undefined);
    await exec("docker", ["network", "rm", network]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  };

  const keeper = nodes[0]!;
  const config = (node: string, i: number) => `<clickhouse>
${
  i === 0
    ? `  <keeper_server>
    <tcp_port>9181</tcp_port>
    <server_id>1</server_id>
    <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
    <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
    <raft_configuration><server><id>1</id><hostname>${keeper}</hostname><port>9234</port></server></raft_configuration>
  </keeper_server>
`
    : ""
}  <zookeeper><node><host>${keeper}</host><port>9181</port></node></zookeeper>
  <macros><shard>s1</shard><replica>r${i + 1}</replica></macros>
  <interserver_http_host>${node}</interserver_http_host>
</clickhouse>
`;

  const hostEndpoint = async (node: string): Promise<ClickHouseEndpoint> => ({ url: `http://127.0.0.1:${await publishedPort(node, 8123)}` });
  const waitReady = async (node: string, endpoint: ClickHouseEndpoint, deadline: number): Promise<void> => {
    for (;;) {
      const ready = (await clickhousePing(endpoint)) && (await clickhouseQuery(endpoint, "SELECT count() FROM system.zookeeper WHERE path = '/'").then(() => true, () => false));
      if (ready) return;
      if (Date.now() > deadline) throw new Error(`${node} did not answer and reach Keeper within the timeout`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  try {
    await exec("docker", ["network", "create", network]);
    const endpoints = await Promise.all(
      nodes.map(async (node, i) => {
        await exec(
          "docker",
          ["create", "--name", node, "--hostname", node, "--network", network, "-p", "127.0.0.1::8123", "-e", "CLICKHOUSE_SKIP_USER_SETUP=1", image],
          { timeout: 600_000 },
        );
        const file = join(dir, `${node}.xml`);
        writeFileSync(file, config(node, i));
        // Readable by the server's own user once copied in, whatever the umask made it.
        chmodSync(file, 0o644);
        await exec("docker", ["cp", file, `${node}:/etc/clickhouse-server/config.d/chant-cluster.xml`]);
        await exec("docker", ["start", node]);
        return hostEndpoint(node);
      }),
    );

    const deadline = Date.now() + (options.readyTimeoutMs ?? 90_000);
    for (const [i, endpoint] of endpoints.entries()) await waitReady(nodes[i]!, endpoint, deadline);
    const node = (index: number): string => {
      const n = nodes[index];
      if (!n) throw new Error(`no replica ${index} in ${name}`);
      return n;
    };
    return {
      replicas: endpoints,
      name,
      stop,
      async stopReplica(index) {
        await exec("docker", ["stop", node(index)], { timeout: 120_000 });
      },
      async startReplica(index) {
        await exec("docker", ["start", node(index)]);
        const endpoint = await hostEndpoint(node(index));
        await waitReady(node(index), endpoint, Date.now() + (options.readyTimeoutMs ?? 90_000));
        endpoints[index] = endpoint;
        return endpoint;
      },
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
