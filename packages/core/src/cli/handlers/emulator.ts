import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { emulatorLifecycle, emulatorsOf, type EmulatorCapability } from "../../op";
import type { LexiconPlugin } from "../../lexicon";
import { formatError, formatWarning, formatSuccess } from "../format";
import type { CommandContext } from "../registry";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** One emulator's state — the machine-readable `--json` unit (#920). */
export interface EmulatorReport {
  lexicon: string;
  /** Container name (e.g. `chant-floci`). */
  name: string;
  /** `http://localhost:<port>` when up; empty when down. */
  endpoint: string;
  /** Env that points the SDK / `chant graph --live` / a triggered Op at it. */
  env: Record<string, string>;
  /**
   * `status` only (#3673): the container runs, but its endpoint reaches
   * another server. `endpoint` and `env` are then empty, so a consumer does
   * not point tooling at the wrong server.
   */
  conflict?: string;
}

const ACTIONS = new Set(["up", "down", "status"]);

/** A running container, a stopped one, or docker could not be asked (#3673). */
type ContainerState = { running: boolean } | { error: string };

/** Whether a container of this name is running, or why docker could not say. */
async function containerState(name: string): Promise<ContainerState> {
  try {
    const { stdout } = await execAsync(`docker ps -q -f name=${name}`);
    return { running: Boolean(stdout.trim()) };
  } catch (err) {
    // The shell exits 127 when the command is not on PATH. Reporting that as
    // "down" told a user with running containers that nothing was running.
    const e = err as { code?: number | string; stderr?: string; message?: string };
    if (e.code === 127 || e.code === "ENOENT") return { error: "docker not found on PATH; cannot check the emulator" };
    const why = (e.stderr || e.message || "").trim().split("\n")[0];
    return { error: `docker could not list containers${why ? ` (${why})` : ""}; cannot check the emulator` };
  }
}

/** The host port Docker publishes `containerPort` on, or undefined when it cannot tell. */
async function publishedPort(name: string, containerPort: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("docker", ["port", name, `${containerPort}/tcp`]);
    const match = /:(\d+)\s*$/m.exec(stdout.trim().split("\n")[0] ?? "");
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `endpoint` reaches this container's server (#3673): the identity
 * read inside the container against the one read through the endpoint.
 * Returns the problem, or undefined when they agree or the check cannot run.
 */
export async function endpointConflict(
  lexicon: string,
  cap: EmulatorCapability,
  endpoint: string,
  port: number,
): Promise<string | undefined> {
  const identity = cap.spec.identity;
  if (!identity) return undefined;
  let inside: string;
  try {
    inside = (await execFileAsync("docker", ["exec", cap.spec.name, ...identity.command])).stdout.trim();
  } catch {
    return undefined; // the container cannot answer for itself; nothing to compare
  }
  const hint =
    `Run \`chant emulator down --lexicon ${lexicon}\`, then \`chant emulator up --lexicon ${lexicon} --port ${cap.spec.containerPort}=<free port>\`.`;
  let answered: { id: string; label: string };
  try {
    answered = await identity.probe(endpoint);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `localhost:${port} does not answer as the emulator (${why}); another ${identity.server} may hold 127.0.0.1:${port}. ${hint}`;
  }
  if (answered.id.trim() === inside) return undefined;
  return `localhost:${port} answers as ${answered.label}, not the emulator; another ${identity.server} holds 127.0.0.1:${port}. ${hint}`;
}

/**
 * `--port` values as container port to host port (#3673). A bare number
 * applies when exactly one emulator is selected.
 */
export function parsePortMappings(values: readonly string[], targets: readonly EmulatorCapability[]): Map<number, number> {
  const ports = new Map<number, number>();
  for (const value of values) {
    const pair = /^(\d+)=(\d+)$/.exec(value);
    const bare = /^(\d+)$/.exec(value);
    if (pair) {
      const containerPort = Number(pair[1]);
      if (!targets.some((t) => t.spec.containerPort === containerPort)) {
        const known = targets.map((t) => `${t.spec.containerPort} (${t.spec.name})`).join(", ");
        throw new Error(`--port ${value}: no selected emulator listens on ${containerPort}; the selected ones use ${known || "none"}`);
      }
      ports.set(containerPort, Number(pair[2]));
    } else if (bare) {
      if (targets.length !== 1) {
        throw new Error(`--port ${value} is ambiguous with ${targets.length} emulators selected; use --port <container-port>=<host-port>`);
      }
      ports.set(targets[0]!.spec.containerPort, Number(bare[1]));
    } else {
      throw new Error(`--port ${value}: expected <container-port>=<host-port>, e.g. --port 5432=15432`);
    }
  }
  return ports;
}

/**
 * `chant emulator --help` (#3673): the subcommands and flags, and for each
 * configured lexicon's emulator the port, endpoint and sign-in a client uses.
 */
export function formatEmulatorHelp(plugins: readonly LexiconPlugin[]): string {
  const lines = [
    "Usage: chant emulator <up|down|status> [--lexicon <name>] [--port <container-port>=<host-port>] [--json]",
    "",
    "Boot, stop or inspect the local emulators of the project's configured lexicons.",
    "",
    "Subcommands:",
    "  up       Boot each emulator, or reuse a running one, and wait until it is ready.",
    "           Refuses when another process already holds the host port on 127.0.0.1.",
    "  down     Stop and remove the containers.",
    "  status   Report whether each emulator runs, and check that its endpoint reaches it.",
    "           Exits 1 when docker cannot be asked or an endpoint reaches another server.",
    "",
    "Flags:",
    "  --lexicon <name>     Act on one lexicon's emulators only.",
    "  --port <c>=<h>       up: publish container port <c> on host port <h>; repeatable.",
    "                       A bare <h> works when one emulator is selected.",
    "  --json               Print the machine-readable report on stdout.",
    "",
  ];
  const caps = plugins.flatMap((p) => emulatorsOf(p.emulator).map((cap) => ({ lexicon: p.name, cap })));
  if (caps.length === 0) {
    lines.push("No lexicon configured for this project has a local emulator.");
    return lines.join("\n");
  }
  lines.push("Emulators in this project (default ports):");
  for (const { lexicon, cap } of caps) {
    const endpoint = emulatorLifecycle(cap.spec).endpoint(cap.spec.containerPort);
    lines.push(`  ${lexicon}: ${cap.spec.name}, port ${cap.spec.containerPort}, ${endpoint}`);
    if (cap.spec.credentials) lines.push(`      sign in: ${cap.spec.credentials}`);
    const env = Object.entries(cap.env(endpoint)).map(([k, v]) => `${k}=${v}`);
    if (env.length) lines.push(`      env: ${env.join(" ")}`);
  }
  return lines.join("\n");
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
    console.error(formatError({ message: "Usage: chant emulator <up|down|status> [--lexicon <name>] [--port <container-port>=<host-port>] [--json]; chant emulator --help lists the ports and sign-in" }));
    return 1;
  }

  // One entry per emulator, not per lexicon (#1345): fly ships two — mudflaps
  // for the Machines API and spritzer for Sprites — and reporting a lexicon
  // would have to pick one of them.
  const targets = plugins
    .filter((p) => !args.lexicon || p.name === args.lexicon)
    .flatMap((p) => emulatorsOf(p.emulator).map((cap) => ({ lexicon: p.name, cap })));
  if (targets.length === 0) {
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

  let ports: Map<number, number>;
  try {
    if (args.port?.length && action !== "up") throw new Error("--port applies to `chant emulator up` only");
    ports = parsePortMappings(args.port ?? [], targets.map((t) => t.cap));
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  const reports: EmulatorReport[] = [];
  for (const { lexicon, cap } of targets) {
    const lc = emulatorLifecycle(cap.spec);
    if (action === "up") {
      const port = ports.get(cap.spec.containerPort);
      try {
        const { endpoint } = await lc.up(port === undefined ? {} : { port });
        reports.push({ lexicon, name: cap.spec.name, endpoint, env: cap.env(endpoint) });
      } catch (err) {
        console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
        return 1;
      }
    } else if (action === "down") {
      await lc.down();
      reports.push({ lexicon, name: cap.spec.name, endpoint: "", env: {} });
    } else {
      const state = await containerState(cap.spec.name);
      if ("error" in state) {
        console.error(formatError({ message: state.error }));
        return 1;
      }
      if (!state.running) {
        reports.push({ lexicon, name: cap.spec.name, endpoint: "", env: {} });
        continue;
      }
      // The port `up` published, which `--port` may have moved off the default.
      const port = (await publishedPort(cap.spec.name, cap.spec.containerPort)) ?? cap.spec.containerPort;
      const endpoint = lc.endpoint(port);
      const conflict = await endpointConflict(lexicon, cap, endpoint, port);
      reports.push(conflict
        ? { lexicon, name: cap.spec.name, endpoint: "", env: {}, conflict }
        : { lexicon, name: cap.spec.name, endpoint, env: cap.env(endpoint) });
    }
  }

  const exit = reports.some((r) => r.conflict) ? 1 : 0;
  if (args.json) {
    console.log(JSON.stringify({ emulators: reports }));
    return exit;
  }
  for (const r of reports) {
    if (action === "up") console.error(formatSuccess(`${r.lexicon}: ${r.name} up on ${r.endpoint}`));
    else if (action === "down") console.error(formatSuccess(`${r.lexicon}: ${r.name} down`));
    else if (r.conflict) console.error(formatError({ message: `${r.lexicon}: ${r.name} runs, but ${r.conflict}` }));
    else console.error(`${r.lexicon}: ${r.name} — ${r.endpoint ? `up on ${r.endpoint}` : "down"}`);
  }
  return exit;
}
