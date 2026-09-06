/**
 * `chant acp` on the process's own stdio (#2125).
 *
 * Split from ./index.ts so mounting the command group costs nothing: this
 * module is imported only once a client has actually spawned the agent.
 *
 * stdout is the protocol. Nothing else may write to it for the life of the
 * process — every turn holds the output capture (./output.ts) precisely so a
 * command's `console.log` cannot land between two JSON-RPC lines.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpServer } from "./server";
import { streamTransport } from "./jsonrpc";

/** Serve until the client closes stdin, which is how it says the connection is over. */
export async function serveAcpOverStdio(opts: { durableRequests?: boolean } = {}): Promise<void> {
  const server = new AcpServer({
    durableRequests: opts.durableRequests ?? false,
    version: lexiconVersion(),
  });

  const transport = streamTransport(process.stdin, process.stdout);
  server.connect(transport);

  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
}

/** The lexicon's own version, reported as `agentInfo.version`. */
function lexiconVersion(): string {
  try {
    const pkgPath = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}
