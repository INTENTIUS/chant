/**
 * A local Fly Machines API that runs its Machines (#2831), as a command:
 *
 *   tsx node_modules/@intentius/chant-lexicon-fly/src/op/activities/machines-local-cli.ts \
 *     [--listen 4280] [--root <dir>] [--publish <port> | --publish <name>=<port> ...] [--log <file>]
 *
 * Point the release activities at it with `FLY_FLAPS_BASE_URL=http://127.0.0.1:4280`.
 * `--publish 8080` publishes every Machine's service on 8080; `--publish web=8080`
 * publishes the Machine named `web` there; with no `--publish` each Machine gets a free
 * port, which the event lines say. SIGINT or SIGTERM stops every Machine's process
 * and exits. See ./machines-local.ts.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveLocalMachines, type LocalPublish } from "./machines-local";

export function parseArgs(argv: string[]): { port: number; root?: string; publish?: LocalPublish; log?: string } {
  let port = 4280;
  let root: string | undefined;
  let log: string | undefined;
  let all: number | undefined;
  const byName: Record<string, number> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--listen") port = Number(value);
    else if (flag === "--root") root = value;
    else if (flag === "--log") log = value;
    else if (flag === "--publish") {
      const eq = value.lastIndexOf("=");
      if (eq === -1) all = Number(value);
      else byName[value.slice(0, eq)] = Number(value.slice(eq + 1));
    } else throw new Error(`unknown flag ${flag}`);
    i++;
  }
  for (const n of [port, all, ...Object.values(byName)]) if (n !== undefined && !Number.isInteger(n)) throw new Error(`not a port: ${n}`);
  const named = Object.keys(byName).length > 0;
  const publish: LocalPublish | undefined =
    named ? (app, m) => byName[`${app}/${m.name}`] ?? byName[m.name] ?? all : all;
  return { port, root, publish, log };
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`machines-local: ${(error as Error).message}`);
    console.error("usage: machines-local-cli.ts [--listen <port>] [--root <dir>] [--publish <port> | --publish <name>=<port>]... [--log <file>]");
    process.exit(2);
  }
  const served = await serveLocalMachines({ ...args, handleSignals: false, onEvent: (line) => console.log(`machines-local: ${line}`) });
  console.log(`machines-local: flaps on ${served.url}${args.root ? `, guest paths under ${args.root}` : ""}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void served.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) void main();
