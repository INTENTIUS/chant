/**
 * A throwaway `clickhouse-server` in a container: started on a random loopback
 * port under a unique name, and always removed.
 *
 * Generation uses it on a pin move to read the pinned server's catalog. The
 * live tests use the same helper so every container chant starts is started
 * and cleaned up one way.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { clickhousePing, type ClickHouseEndpoint } from "./http";

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
