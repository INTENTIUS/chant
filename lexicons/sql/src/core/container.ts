/**
 * A throwaway database server in a container, for every dialect: started on a
 * random loopback port under a unique name, waited on until it answers, and
 * always removed.
 *
 * Generation uses it on a pin move to read the pinned server's catalog, and
 * the live tests use it so every container chant starts is started and
 * cleaned up one way. What "answers" means (an HTTP ping, a query) and the
 * image's environment are the dialect's.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);

/** True when a Docker daemon answers. Tests that need a server skip when this is false. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** A container name no other run picks: `<prefix>-<pid>-<random>`. */
export function uniqueContainerName(prefix: string): string {
  return `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/** The loopback host port Docker published for `containerPort` on `name`. */
export async function publishedPort(name: string, containerPort: number): Promise<string> {
  const { stdout } = await exec("docker", ["port", name, `${containerPort}/tcp`]);
  const port = stdout.split("\n")[0]?.trim().split(":").pop();
  if (!port) throw new Error(`docker port reported no host port for ${name}`);
  return port;
}

export interface ScratchContainer {
  /** The container's name, for a log line. */
  name: string;
  /** The loopback host port `containerPort` is published on. */
  port: string;
  /** Remove the container. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Run `image` detached, publish `containerPort` on a random loopback port,
 * and wait until `ready(port)` is true, polling every half second. Pulls the
 * image when it is not present, which is the one network step here. On any
 * failure the container is removed before the error is thrown.
 */
export async function startScratchContainer(options: {
  image: string;
  namePrefix: string;
  containerPort: number;
  env?: Readonly<Record<string, string>>;
  ready: (port: string) => Promise<boolean>;
  readyTimeoutMs: number;
  /** What the container did not do in time, for the error: `did not answer /ping`. */
  notReady: string;
}): Promise<ScratchContainer> {
  const name = uniqueContainerName(options.namePrefix);
  let removed = false;
  const stop = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await exec("docker", ["rm", "-f", name]).catch(() => undefined);
  };

  try {
    const env = Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    await exec("docker", ["run", "-d", "--name", name, "-p", `127.0.0.1::${options.containerPort}`, ...env, options.image], { timeout: 600_000 });
    const port = await publishedPort(name, options.containerPort);
    const deadline = Date.now() + options.readyTimeoutMs;
    while (!(await options.ready(port))) {
      if (Date.now() > deadline) throw new Error(`${name} ${options.notReady} within the timeout`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return { name, port, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
