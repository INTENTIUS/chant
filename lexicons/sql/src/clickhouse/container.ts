/**
 * A throwaway `clickhouse-server` in a container: started on a random loopback
 * port under a unique name, and always removed.
 *
 * Generation uses it on a pin move to read the pinned server's catalog. The
 * live tests use the same helper so every container chant starts is started
 * and cleaned up one way.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { clickhousePing, clickhouseQuery, type ClickHouseEndpoint } from "./http";

const exec = promisify(execFile);

export interface ScratchServer {
  endpoint: ClickHouseEndpoint;
  /** The container's name, for a log line. */
  name: string;
  /** Remove the container. Safe to call twice. */
  stop(): Promise<void>;
}

/** True when a Docker daemon answers. Tests that need a server skip when this is false. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start `image` and wait until it answers `/ping`. Pulls the image when it is
 * not present, which is the one network step here.
 */
export async function startScratchServer(
  image: string,
  options: { namePrefix?: string; readyTimeoutMs?: number } = {},
): Promise<ScratchServer> {
  const name = `${options.namePrefix ?? "chant-sql"}-${process.pid}-${randomBytes(4).toString("hex")}`;
  let removed = false;
  const stop = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
  };

  try {
    await exec(
      "docker",
      ["run", "-d", "--name", name, "-p", "127.0.0.1::8123", "-e", "CLICKHOUSE_SKIP_USER_SETUP=1", image],
      { timeout: 600_000 },
    );
    const { stdout } = await exec("docker", ["port", name, "8123/tcp"]);
    const port = stdout.split("\n")[0]?.trim().split(":").pop();
    if (!port) throw new Error(`docker port reported no host port for ${name}`);
    const endpoint: ClickHouseEndpoint = { url: `http://127.0.0.1:${port}` };

    const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
    while (!(await clickhousePing(endpoint))) {
      if (Date.now() > deadline) throw new Error(`${name} did not answer /ping within the timeout`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return { endpoint, name, stop };
  } catch (err) {
    await stop();
    throw err;
  }
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
  const name = `${options.namePrefix ?? "chant-sql-cluster"}-${process.pid}-${randomBytes(4).toString("hex")}`;
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

  const hostEndpoint = async (node: string): Promise<ClickHouseEndpoint> => {
    const { stdout } = await exec("docker", ["port", node, "8123/tcp"]);
    const port = stdout.split("\n")[0]?.trim().split(":").pop();
    if (!port) throw new Error(`docker port reported no host port for ${node}`);
    return { url: `http://127.0.0.1:${port}` };
  };
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
