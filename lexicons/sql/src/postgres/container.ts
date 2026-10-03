/**
 * A throwaway `postgres` server in a container, for catalog generation and the
 * live tests: started under a unique name with no published port, queried with
 * `docker exec psql`, and always removed.
 *
 * The official image restarts the server once after `initdb`, so the ready
 * line appears twice in its log; the server is ready on the second.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { uniqueContainerName } from "../core/container";

export { dockerAvailable } from "../core/container";

const exec = promisify(execFile);

export interface ScratchPostgres {
  /** The container's name, for a log line. */
  name: string;
  /** Run a SQL script with psql as `postgres` (`-qAt`, stop at the first error) and return its stdout. */
  psql(sql: string): Promise<string>;
  /** Remove the container. Safe to call twice. */
  stop(): Promise<void>;
}

function psqlIn(name: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", name, "psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf-8"));
      else reject(new Error(`psql failed (${code}): ${Buffer.concat(err).toString("utf-8").trim()}`));
    });
    child.stdin.end(sql);
  });
}

/** Start `image` and wait until the server accepts connections. Pulls the image when it is absent. */
export async function startScratchPostgres(
  image: string,
  options: { namePrefix?: string; readyTimeoutMs?: number } = {},
): Promise<ScratchPostgres> {
  const name = uniqueContainerName(options.namePrefix ?? "chant-sql-pg");
  let removed = false;
  const stop = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await exec("docker", ["rm", "-f", "-v", name]).catch(() => undefined);
  };
  try {
    await exec("docker", ["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=chant", image], { timeout: 600_000 });
    const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
    for (;;) {
      const logs = await exec("docker", ["logs", name]).then(
        (r) => `${r.stdout}${r.stderr}`,
        () => "",
      );
      if ((logs.match(/database system is ready to accept connections/g) ?? []).length >= 2) break;
      if (Date.now() > deadline) throw new Error(`${name} did not accept connections within the timeout`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return { name, psql: (sql) => psqlIn(name, sql), stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
