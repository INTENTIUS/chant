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
import { setGateOrigin } from "@intentius/chant/lifecycle/gate-origin";
import { setStewardTurn } from "@intentius/chant/op/steward-turn";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpServer } from "./server";
import { streamTransport } from "./jsonrpc";

/** Serve until the client closes stdin, which is how it says the connection is over. */
export async function serveAcpOverStdio(opts: { durableRequests?: boolean; steward?: string } = {}): Promise<void> {
  // chant#2384 — every prompt this session carries is authored by the model,
  // and `approve` is a verb in chant's registry like any other, so nothing in
  // the transport stops `chant run <op>` being followed by
  // `chant approve <op> <gate>` as the next prompt. Declaring the channel is
  // what makes the gate ledger able to tell that apart from a person at a
  // shell; the same-origin rule then refuses it.
  setGateOrigin("acp");

  // chant#2749 — the session is a steward's. A decision point an Op asks during
  // a turn names the steward, makes its model call through the steward's
  // brokered capability, and is left open for a person; `points answer` from
  // this session is refused, as the gate's resolution is above.
  if (opts.steward) setStewardTurn({ steward: opts.steward });

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
