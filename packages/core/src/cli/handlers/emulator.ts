import { exec } from "node:child_process";
import { promisify } from "node:util";
import { emulatorLifecycle } from "../../op";
import { formatError, formatWarning, formatSuccess } from "../format";
import type { CommandContext } from "../registry";

const execAsync = promisify(exec);

/** One emulator's state — the machine-readable `--json` unit (#920). */
export interface EmulatorReport {
  lexicon: string;
  /** Container name (e.g. `chant-floci`). */
  name: string;
  /** `http://localhost:<port>` when up; empty when down. */
  endpoint: string;
  /** Env that points the SDK / `chant graph --live` / a triggered Op at it. */
  env: Record<string, string>;
}

const ACTIONS = new Set(["up", "down", "status"]);

/** True if a container of this name is running. */
async function isRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker ps -q -f name=${name}`);
    return Boolean(stdout.trim());
  } catch {
    return false; // docker missing / not running — treat as down
  }
}

/**
 * chant emulator up|down|status [--lexicon <name>] [--json]  (#920)
 *
 * Boot / stop / inspect the local emulators of the project's configured lexicons
 * (Floci for aws, floci-az/gcp, mudflaps/spritzer for fly). `up` leaves them
 * running (persistent, unlike the in-Op boot/teardown) so a consumer can deploy to
 * and observe them; `--json` reports each one's endpoint + the env that redirects
 * tooling at it. Consumed by behold `serve --local`.
 */
export async function runEmulator(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  // Registered as compound `emulator <up|down|status>`, so the action word lands
  // in args.path; the bare `emulator` fallback leaves it as the "." default.
  const action = args.path;
  if (!action || !ACTIONS.has(action)) {
    console.error(formatError({ message: "Usage: chant emulator <up|down|status> [--lexicon <name>] [--json]" }));
    return 1;
  }

  const withEmulator = plugins.filter((p) => p.emulator && (!args.lexicon || p.name === args.lexicon));
  if (withEmulator.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ emulators: [] }));
      return 0;
    }
    console.error(formatWarning({
      message: args.lexicon
        ? `Lexicon "${args.lexicon}" has no local emulator, or isn't configured for this project`
        : "No configured lexicon has a local emulator",
    }));
    return 0;
  }

  const reports: EmulatorReport[] = [];
  for (const p of withEmulator) {
    const cap = p.emulator!;
    const lc = emulatorLifecycle(cap.spec);
    if (action === "up") {
      const { endpoint } = await lc.up();
      reports.push({ lexicon: p.name, name: cap.spec.name, endpoint, env: cap.env(endpoint) });
    } else if (action === "down") {
      await lc.down();
      reports.push({ lexicon: p.name, name: cap.spec.name, endpoint: "", env: {} });
    } else {
      const running = await isRunning(cap.spec.name);
      const endpoint = running ? lc.endpoint(cap.spec.containerPort) : "";
      reports.push({ lexicon: p.name, name: cap.spec.name, endpoint, env: endpoint ? cap.env(endpoint) : {} });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ emulators: reports }));
    return 0;
  }
  for (const r of reports) {
    if (action === "up") console.error(formatSuccess(`${r.lexicon}: ${r.name} up on ${r.endpoint}`));
    else if (action === "down") console.error(formatSuccess(`${r.lexicon}: ${r.name} down`));
    else console.error(`${r.lexicon}: ${r.name} — ${r.endpoint ? `up on ${r.endpoint}` : "down"}`);
  }
  return 0;
}
