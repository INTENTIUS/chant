/**
 * A local Fly Machines API that runs its Machines (#2831).
 *
 * ./machines-fake.ts answers the flaps endpoints from memory and runs nothing,
 * and so does mudflaps. That is what unit tests want, and it stays the
 * default. This module is the opt-in running mode: the same in-memory API,
 * with each started Machine run as a process on this host, so a release that
 * puts a source tree on a Machine (`config.files` plus `init.cmd`) can be
 * checked over HTTP.
 *
 * For each Machine the fake holds in state `started`:
 *
 *   - `config.files` are written at their `guest_path` (under `root` when one
 *     is given), and the files an earlier instance wrote are removed first, as
 *     a Machine's root filesystem starts again from its image;
 *   - `config.mounts` are directories that outlive instances (a Volume);
 *   - `init.exec`, or `init.entrypoint` then `init.cmd`, runs with
 *     `config.env`, and an `exec` (a migration) runs its command with the same
 *     env;
 *   - a service's `internal_port` is published on a host port: when the
 *     Machine's env sets `PORT` to an `internal_port`, the process gets the
 *     host port instead, since every Machine here shares the host's network.
 *
 * No image is pulled: the command runs on this host's binaries (a Node app
 * runs on this host's Node).
 *
 * A create or an update (a new `instance_id`) starts the process again, a
 * `restart` restarts it, a `stop` or a delete stops it, and a process that
 * exits on its own leaves its Machine `stopped`. Each call answers only after
 * that is done, and a started process is given until its published port
 * accepts a connection, so the next call (a migration's exec, a health check)
 * finds the files and the server.
 *
 * Processes run in their own process group. `close()` stops them all
 * (SIGTERM, then SIGKILL); if the host process exits or is ended by SIGINT,
 * SIGTERM or SIGHUP first, they are killed with it. Only a SIGKILL of the host
 * process can leave them running.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createConnection, createServer as createNetServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { FlyHttp } from "./fly-apply";
import { createMachinesFake, type FakeExecResult, type FakeMachine, type MachinesFake, type MachinesFakeOptions } from "./machines-fake";

/** Where a Machine's service is published: one port for every Machine, a port per Machine name (or `app/name`), or a function. */
export type LocalPublish = number | Record<string, number> | ((app: string, machine: FakeMachine) => number | undefined);

export interface LocalMachinesOptions {
  /**
   * A host directory the Machines' guest paths are placed under: `/srv/app`
   * becomes `<root>/srv/app`, in the files written, the mounts, and the
   * command, exec and env strings that name those paths. Default: none, so a
   * guest path is the same path on this host (a container or a box made for it).
   */
  root?: string;
  /** The host port a Machine's service is published on. Default: a free port per Machine, kept for its name. */
  publish?: LocalPublish;
  /** A file the processes' stdout and stderr are appended to. Default: this process's stderr. */
  log?: string;
  /** How long a started process is given to accept a connection on its published port. Default 15s. */
  readyTimeoutMs?: number;
  /** How long a stopped process is given after SIGTERM before SIGKILL. Default 5s. */
  stopTimeoutMs?: number;
  /** What happens, one line at a time (starts, stops, execs). Default: nothing is said. */
  onEvent?: (line: string) => void;
  /**
   * Kill the processes when this process gets SIGINT, SIGTERM or SIGHUP, then raise the signal again if nothing
   * else handles it. Default true; a caller that handles those signals itself (and calls `close()`) passes false.
   */
  handleSignals?: boolean;
  /** Passed to the fake: the state a created or updated Machine settles in. */
  settle?: MachinesFakeOptions["settle"];
}

/** A Machine's process, as {@link LocalMachines.processes} reports it. */
export interface LocalProcess {
  app: string;
  id: string;
  name: string;
  instance: string;
  pid: number | undefined;
  /** The host port its service is published on, when its env names one. */
  port: number | undefined;
}

export interface LocalMachines extends MachinesFake {
  /** `http://127.0.0.1:<port>` for the running Machine `name` in `app`, when its service is published. */
  endpoint(app: string, name: string): string | undefined;
  /** The processes running now. */
  processes(): LocalProcess[];
  /** Stop every process and remove its files. Mounts are kept. */
  close(): Promise<void>;
}

interface Running {
  app: string;
  id: string;
  name: string;
  instance: string;
  files: string[];
  child: ChildProcess | undefined;
  port: number | undefined;
  stopping: boolean;
  exited: boolean;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Is `pid`'s process group still there? */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((ok, fail) => srv.once("error", fail).listen(0, "127.0.0.1", ok));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((ok) => srv.close(() => ok()));
  return port;
}

function connects(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/** An in-memory Machines API that runs each started Machine on this host. See the module header. */
export function createLocalMachines(options: LocalMachinesOptions = {}): LocalMachines {
  const root = options.root;
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const say = options.onEvent ?? (() => undefined);
  const running = new Map<string, Running>();
  /** Host ports picked for Machines with no declared one, by `app/name`, so a new instance serves where the last did. */
  const picked = new Map<string, number>();

  const host = (guest: string) => (root ? join(root, guest) : guest);

  /** Rewrites guest paths named in a string to host paths (identity with no root). */
  function mapperOf(config: FakeMachine["config"]): (s: string) => string {
    if (!root) return (s) => s;
    const prefixes = new Set<string>();
    for (const m of (config.mounts as Array<{ path?: string }> | undefined) ?? []) if (m.path) prefixes.add(m.path.replace(/\/+$/, ""));
    for (const f of (config.files as Array<{ guest_path?: string }> | undefined) ?? []) if (f.guest_path) prefixes.add(dirname(f.guest_path));
    prefixes.delete("");
    prefixes.delete("/");
    if (prefixes.size === 0) return (s) => s;
    const alts = [...prefixes].sort((a, b) => b.length - a.length).map(escape).join("|");
    const re = new RegExp(`(^|[\\s=:'"(;&|])(${alts})(?=$|[/\\s'":;)&|])`, "g");
    return (s) => s.replace(re, (_m, pre: string, path: string) => `${pre}${host(path)}`);
  }

  async function publishedPort(app: string, m: FakeMachine): Promise<number | undefined> {
    const env = (m.config.env as Record<string, string> | undefined) ?? {};
    const internal = ((m.config.services as Array<{ internal_port?: number }> | undefined) ?? []).map((s) => String(s.internal_port));
    if (env.PORT === undefined || !internal.includes(String(env.PORT))) return undefined;
    const p = options.publish;
    const declared =
      typeof p === "number" ? p : typeof p === "function" ? p(app, m) : p ? (p[`${app}/${m.name}`] ?? p[m.name]) : undefined;
    if (declared !== undefined) return declared;
    const key = `${app}/${m.name}`;
    if (!picked.has(key)) picked.set(key, await freePort());
    return picked.get(key);
  }

  function envOf(config: FakeMachine["config"], port: number | undefined): Record<string, string> {
    const map = mapperOf(config);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" };
    for (const [k, v] of Object.entries((config.env as Record<string, string> | undefined) ?? {})) env[k] = map(String(v));
    if (port !== undefined) env.PORT = String(port);
    return env;
  }

  function argvOf(config: FakeMachine["config"]): string[] | undefined {
    const init = (config.init ?? {}) as { exec?: string[]; entrypoint?: string[]; cmd?: string[] | string };
    const map = mapperOf(config);
    if (init.exec?.length) return init.exec.map(map);
    const cmd = typeof init.cmd === "string" ? ["sh", "-c", init.cmd] : (init.cmd ?? []);
    const argv = [...(init.entrypoint ?? []), ...cmd];
    return argv.length ? argv.map(map) : undefined;
  }

  const stdio = (): { out: number; close: () => void } => {
    if (!options.log) return { out: 2, close: () => undefined };
    mkdirSync(dirname(options.log), { recursive: true });
    const fd = openSync(options.log, "a");
    return { out: fd, close: () => closeSync(fd) };
  };

  async function stop(key: string): Promise<void> {
    const r = running.get(key);
    if (!r) return;
    running.delete(key);
    r.stopping = true;
    const child = r.child;
    if (child?.pid && groupAlive(child.pid)) {
      const exited = child.exitCode === null && child.signalCode === null ? new Promise((ok) => child.once("exit", ok)) : Promise.resolve();
      killGroup(child, "SIGTERM");
      const deadline = Date.now() + stopTimeoutMs;
      // Wait for the leader to exit and the rest of its group to go.
      await Promise.race([exited, new Promise((ok) => setTimeout(ok, stopTimeoutMs))]);
      while (groupAlive(child.pid) && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 25));
      if (groupAlive(child.pid)) {
        killGroup(child, "SIGKILL");
        while (groupAlive(child.pid)) await new Promise((ok) => setTimeout(ok, 25));
      }
    }
    for (const path of r.files) rmSync(path, { force: true });
    say(`stopped ${key} (instance ${r.instance})`);
  }

  async function start(app: string, m: FakeMachine): Promise<void> {
    const key = `${app}/${m.id}`;
    await stop(key);
    const { config } = m;
    for (const mount of (config.mounts as Array<{ path?: string }> | undefined) ?? []) if (mount.path) mkdirSync(host(mount.path), { recursive: true });
    const files: string[] = [];
    for (const f of (config.files as Array<{ guest_path: string; raw_value?: string; mode?: number }> | undefined) ?? []) {
      const path = host(f.guest_path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(f.raw_value ?? "", "base64"));
      if (f.mode) chmodSync(path, f.mode);
      files.push(path);
    }
    const argv = argvOf(config);
    const port = argv ? await publishedPort(app, m) : undefined;
    const r: Running = { app, id: m.id, name: m.name, instance: m.instance_id, files, child: undefined, port, stopping: false, exited: false };
    running.set(key, r);
    if (!argv) {
      say(`started ${key} instance ${m.instance_id}: ${files.length} files, no command`);
      return;
    }
    const log = stdio();
    const child = spawn(argv[0], argv.slice(1), { cwd: root ?? "/", env: envOf(config, port), stdio: ["ignore", log.out, log.out], detached: true });
    log.close();
    child.unref();
    r.child = child;
    child.once("error", (error) => say(`${key} instance ${m.instance_id} failed to start: ${error.message}`));
    child.once("exit", (code, signal) => {
      r.exited = true;
      if (r.stopping) return;
      say(`${key} instance ${m.instance_id} exited ${signal ?? code}`);
      // A process that ends on its own leaves its Machine stopped, and its group is killed with it.
      killGroup(child, "SIGKILL");
      if (m.instance_id === r.instance && m.state === "started") m.state = "stopped";
    });
    say(`started ${key} instance ${m.instance_id}: ${files.length} files, ${argv.join(" ")}${port ? `, on 127.0.0.1:${port}` : ""}`);
    if (port !== undefined) {
      const deadline = Date.now() + readyTimeoutMs;
      while (!r.exited && Date.now() < deadline && !(await connects(port))) await new Promise((ok) => setTimeout(ok, 50));
      if (!r.exited && Date.now() >= deadline) say(`${key} instance ${m.instance_id} is not accepting connections on ${port} after ${readyTimeoutMs}ms`);
    }
  }

  async function exec(app: string, m: FakeMachine, command: string[], timeoutSecs: number): Promise<FakeExecResult> {
    const map = mapperOf(m.config);
    const argv = command.map(map);
    const port = running.get(`${app}/${m.id}`)?.port;
    return new Promise((done) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: root ?? "/", env: envOf(m.config, port), stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d) => (stdout += d));
      child.stderr!.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => killGroup(child, "SIGKILL"), timeoutSecs * 1000);
      child.once("error", (error) => {
        clearTimeout(timer);
        done({ exit_code: 127, stdout, stderr: `${stderr}${error.message}` });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const exit = code ?? (signal ? 128 : 1);
        say(`exec on ${app}/${m.id}: ${command.join(" ")} exited ${signal ?? code}${exit === 0 ? "" : `: ${`${stderr}${stdout}`.trim().slice(-500)}`}`);
        done({ exit_code: exit, stdout, stderr });
      });
    });
  }

  /** The exec timeout the last exec call asked for, read before the fake answers it. */
  let execTimeout = 120;
  const fake = createMachinesFake({
    settle: options.settle,
    exec: (app, m, command) => exec(app, m, command, execTimeout),
  });

  /** Make what runs match the fake's Machines after a call; `restarted` names a Machine (`app/id`) whose process starts again. */
  async function reconcile(restarted: string | undefined): Promise<void> {
    const live = new Set<string>();
    for (const [app, machines] of fake.machines) {
      for (const m of machines) {
        const key = `${app}/${m.id}`;
        live.add(key);
        const r = running.get(key);
        if (m.state !== "started") await stop(key);
        else if (!r || r.exited || r.instance !== m.instance_id || key === restarted) await start(app, m);
      }
    }
    for (const key of [...running.keys()]) if (!live.has(key)) await stop(key);
  }

  // One call at a time, so a start never races the next call.
  let queue: Promise<unknown> = Promise.resolve();
  const http: FlyHttp = (method, url, body, headers, signal) => {
    const next = queue.then(async () => {
      const seg = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (method === "POST" && seg[3] === "machines" && seg[5] === "exec") {
        const t = Number((body as { timeout?: number } | undefined)?.timeout);
        execTimeout = Number.isFinite(t) && t > 0 ? t : 120;
      }
      const out = await fake.http(method, url, body, headers, signal);
      if (method !== "GET" && !(seg[5] === "exec" || seg[5] === "lease" || seg[5] === "wait")) {
        const restarted = method === "POST" && seg[3] === "machines" && seg[5] === "restart" && out.status < 300 ? `${seg[2]}/${seg[4]}` : undefined;
        await reconcile(restarted);
      }
      return out;
    });
    queue = next.catch(() => undefined);
    return next;
  };

  // Nothing is left running when this process ends: on exit, and on a signal (which is then raised again, so it still ends the process).
  const killAll = () => {
    for (const r of running.values()) {
      r.stopping = true;
      killGroup(r.child, "SIGKILL");
    }
  };
  const onSignal = (sig: NodeJS.Signals) => {
    killAll();
    detach();
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  };
  const detach = () => {
    process.off("exit", killAll);
    for (const s of SIGNALS) process.off(s, onSignal);
  };
  process.on("exit", killAll);
  if (options.handleSignals !== false) for (const s of SIGNALS) process.on(s, onSignal);

  return {
    ...fake,
    http,
    endpoint(app, name) {
      const m = fake.machine(app, name);
      const r = m ? running.get(`${app}/${m.id}`) : undefined;
      const port = r && !r.exited ? r.port : undefined;
      return port === undefined ? undefined : `http://127.0.0.1:${port}`;
    },
    processes: () =>
      [...running.values()].filter((r) => !r.exited).map((r) => ({ app: r.app, id: r.id, name: r.name, instance: r.instance, pid: r.child?.pid, port: r.port })),
    async close() {
      await queue;
      for (const key of [...running.keys()]) await stop(key);
      detach();
    },
  };
}

export interface ServeLocalMachinesOptions extends LocalMachinesOptions {
  /** The port the Machines API listens on. Default 4280, mudflaps' port; 0 picks a free one. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
}

export interface ServedLocalMachines {
  /** The flaps base URL, for `FLY_FLAPS_BASE_URL` or an `endpoint` argument. */
  url: string;
  machines: LocalMachines;
  /** Stop every Machine's process, then the server. */
  close(): Promise<void>;
}

/**
 * Serve {@link createLocalMachines} over HTTP, where the release activities
 * reach it through `FLY_FLAPS_BASE_URL`. `GET /_mudflaps/health` answers 200,
 * as mudflaps' health check does.
 */
export async function serveLocalMachines(options: ServeLocalMachinesOptions = {}): Promise<ServedLocalMachines> {
  const machines = createLocalMachines(options);
  const hostname = options.host ?? "127.0.0.1";
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        let out: { status: number; text: string };
        try {
          if (req.method === "GET" && req.url === "/_mudflaps/health") out = { status: 200, text: JSON.stringify({ status: "ok" }) };
          else {
            const text = Buffer.concat(chunks).toString("utf-8");
            out = await machines.http(req.method ?? "GET", `http://${hostname}${req.url}`, text ? JSON.parse(text) : undefined, {});
          }
        } catch (error) {
          out = { status: 500, text: JSON.stringify({ error: (error as Error).message }) };
        }
        res.writeHead(out.status, out.text ? { "content-type": "application/json" } : {});
        res.end(out.text);
      })();
    });
  });
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(options.port ?? 4280, hostname, ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${hostname}:${port}`,
    machines,
    async close() {
      await machines.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
