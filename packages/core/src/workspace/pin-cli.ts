/**
 * `chant workspace pin <path> [--json]` (#2547, ws-065): print the `integrity`
 * value that pins the plugin at `path`, a directory or file inside the
 * workspace. What the hash covers is in ./pin-integrity.ts. The command reads
 * files only, and says whether a path pin the declaration already has for
 * that path matches.
 */

import { relative, resolve, sep } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { readDeclaration, WorkspaceReadError } from "./declaration";
import { integrityOf, PinHashError } from "./pin-integrity";
import { locateWorkspace } from "./which-chant";

const USAGE = "chant workspace pin <path> [--json]";

export async function runWorkspacePin(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const given = args.extraPositional;
  if (!given) {
    console.error(formatError({ message: "chant workspace pin needs the plugin's path", hint: USAGE }));
    return 1;
  }
  try {
    const located = locateWorkspace(process.cwd());
    const declaration = readDeclaration(located.tree, "", { rootChant: true });
    const abs = resolve(process.cwd(), given);
    const rel = relative(located.rootOnDisk, abs).split(sep).join("/");
    if (rel === "" || rel.startsWith("../") || rel === "..") {
      console.error(formatError({ message: `${given} is not inside the workspace`, hint: USAGE }));
      return 1;
    }
    const { integrity, files } = integrityOf(abs);
    const declared = declaration.pins.find((p) => p.path === rel);
    const state = declared === undefined ? "undeclared" : declared.integrity === null ? "declared-unpinned" : declared.integrity === integrity ? "matches" : "differs";
    if (args.json) {
      console.log(JSON.stringify({ path: rel, integrity, files, pin: state }, null, 2));
    } else {
      console.log(integrity);
      const note = {
        undeclared: `${rel} is not a path pin in ${declaration.file}; add { "path": "${rel}", "integrity": "${integrity}" } to pins`,
        "declared-unpinned": `${rel} is a path pin with no integrity; add "integrity": "${integrity}" to it`,
        matches: `${rel} matches the integrity its pin states`,
        differs: `${rel} does not match the integrity its pin states (${declared?.integrity}); update the pin if the change is intended`,
      }[state];
      console.error(`${files} file${files === 1 ? "" : "s"} hashed. ${note}`);
    }
    return state === "differs" ? 1 : 0;
  } catch (err) {
    if (err instanceof WorkspaceReadError || err instanceof PinHashError) {
      console.error(formatError({ message: `${given}: ${err.message}`, hint: USAGE }));
      return 1;
    }
    throw err;
  }
}
