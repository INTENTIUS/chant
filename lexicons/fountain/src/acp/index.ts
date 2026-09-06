/**
 * `chant acp` — the CLI mount for the ACP server (#2125).
 *
 * A command group with a `defaultVerb`, so the bare `chant acp` an editor or a
 * fountain Agent spawns (`runtime_command: "chant acp"`) reaches `serve`
 * without the client having to know chant's verb grammar. `chant acp serve`
 * is the same thing spelled out.
 *
 * The server itself is behind a dynamic import: mounting the group happens
 * every time a plugin loads, and nothing about `chant build` should pay for a
 * JSON-RPC peer it will never open.
 */

import type { CommandGroup, CommandGroupContext } from "@intentius/chant/cli/command-group";
import { splitJoinedFlags, unknownFlagError } from "@intentius/chant/cli/command-group";

const BOOLEAN_FLAGS = new Set(["--durable-requests"]);

/** The verb group `chant acp` mounts. */
export function acpCommandGroup(): CommandGroup {
  return {
    name: "acp",
    description: "Serve chant as an Agent Client Protocol agent over stdio",
    defaultVerb: "serve",
    commands: [
      {
        name: "serve",
        description: "Speak ACP on stdin/stdout; each prompt is one chant command line",
        handler: serveHandler,
      },
    ],
  };
}

async function serveHandler(ctx: CommandGroupContext): Promise<number> {
  let durableRequests = false;
  for (const arg of splitJoinedFlags(ctx.rawArgs, BOOLEAN_FLAGS)) {
    if (arg === "--durable-requests") durableRequests = true;
    else {
      // stdout carries the protocol and nothing else, so a usage error goes
      // to stderr — the one place a spawned agent can say anything.
      console.error(
        unknownFlagError(arg, `"chant acp" accepts --durable-requests.`).message,
      );
      return 1;
    }
  }

  const { serveAcpOverStdio } = await import("./serve");
  await serveAcpOverStdio({ durableRequests });
  return 0;
}
