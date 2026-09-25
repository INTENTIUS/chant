/**
 * An in-memory Fly Machines (flaps) API, as a {@link FlyHttp} (#2736).
 *
 * The twin of ./sprites-fake.ts for the Machines side: the endpoints the
 * applier (./fly-apply.ts) and the release activities (./machine-release.ts)
 * call, answered from memory with the response shapes flaps and mudflaps use.
 * Unit tests inject it where the default client would reach the network; the
 * docker-gated tests run the same activities against the pinned mudflaps.
 *
 * Not an activity: nothing in ./index.ts exports it, so `loadActivities`
 * never binds it.
 */

import type { FlyHttp } from "./fly-apply";

/** One Machine the fake holds. */
export interface FakeMachine {
  id: string;
  name: string;
  state: string;
  instance_id: string;
  config: Record<string, unknown> & { metadata?: Record<string, string> };
}

/** What an `exec` answers: the Machines API's exec envelope. */
export interface FakeExecResult {
  exit_code: number;
  stdout?: string;
  stderr?: string;
}

export interface MachinesFake {
  http: FlyHttp;
  apps: Set<string>;
  machines: Map<string, FakeMachine[]>;
  /** Every exec, in order: the app, the machine id and the command. */
  execs: Array<{ app: string; id: string; command: string[] }>;
  /** Every call, as `METHOD path` (no base, no query). */
  calls: string[];
  /** The live machine named `name` in `app`, if any. */
  machine(app: string, name: string): FakeMachine | undefined;
}

export interface MachinesFakeOptions {
  /** Answer an exec. Default: exit 0 with no output. */
  exec?: (app: string, machine: FakeMachine, command: string[]) => FakeExecResult;
  /** The state a created or updated machine settles in. Default `started`. */
  settle?: (machine: FakeMachine) => string;
}

const json = (status: number, body: unknown) => ({ status, text: body === undefined ? "" : JSON.stringify(body) });

let seq = 0;
const nextId = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(10, "0")}`;

/** A fresh in-memory flaps. */
export function createMachinesFake(options: MachinesFakeOptions = {}): MachinesFake {
  const apps = new Set<string>();
  const machines = new Map<string, FakeMachine[]>();
  const execs: MachinesFake["execs"] = [];
  const calls: string[] = [];
  const settle = options.settle ?? (() => "started");
  const list = (app: string) => machines.get(app) ?? [];
  const find = (app: string, id: string) => list(app).find((m) => m.id === id);

  const http: FlyHttp = async (method, url, body) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(`${method} ${pathname}`);
    const seg = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // seg: ["v1", "apps", app?, kind?, id?, action?]
    if (seg[0] !== "v1" || seg[1] !== "apps") return json(404, { error: "not found" });
    const app = seg[2];
    const b = (body ?? {}) as Record<string, unknown>;

    if (!app) {
      if (method === "POST") {
        const name = String(b.app_name);
        if (apps.has(name)) return json(409, { error: "app exists" });
        apps.add(name);
        return json(201, { name, status: "deployed" });
      }
      return json(200, [...apps].map((name) => ({ name })));
    }
    if (seg.length === 3) {
      if (method === "GET") return apps.has(app) ? json(200, { name: app, status: "deployed" }) : json(404, { error: "app not found" });
      if (method === "DELETE") {
        apps.delete(app);
        machines.delete(app);
        return json(202, undefined);
      }
    }
    if (!apps.has(app)) return json(404, { error: "app not found" });
    const kind = seg[3];

    if (kind === "machines") {
      const id = seg[4];
      const action = seg[5];
      if (!id) {
        if (method === "GET") return json(200, list(app));
        if (method === "POST") {
          const m: FakeMachine = {
            id: nextId("m"),
            name: String(b.name ?? ""),
            state: "created",
            instance_id: nextId("I"),
            config: structuredClone((b.config ?? {}) as FakeMachine["config"]),
          };
          m.state = settle(m);
          machines.set(app, [...list(app), m]);
          return json(200, m);
        }
      }
      const m = id ? find(app, id) : undefined;
      if (!m) return action === "wait" ? json(200, { ok: true }) : json(404, { error: "machine not found" });
      if (!action) {
        if (method === "GET") return json(200, m);
        if (method === "POST") {
          m.config = structuredClone((b.config ?? {}) as FakeMachine["config"]);
          m.instance_id = nextId("I");
          m.state = settle(m);
          return json(200, m);
        }
        if (method === "DELETE") {
          machines.set(app, list(app).filter((x) => x !== m));
          return json(200, { ok: true });
        }
      }
      if (action === "lease") {
        if (method === "POST") return json(200, { data: { nonce: nextId("n") } });
        return json(200, { ok: true });
      }
      if (action === "wait") {
        const want = searchParams.get("state") ?? "started";
        return json(200, { ok: m.state === want });
      }
      if (action === "restart" || action === "start") {
        m.state = "started";
        return json(200, { ok: true });
      }
      if (action === "stop") {
        m.state = "stopped";
        return json(200, { ok: true });
      }
      if (action === "exec" && method === "POST") {
        const command = (b.command as string[] | undefined) ?? String(b.cmd ?? "").split(" ");
        execs.push({ app, id: m.id, command });
        return json(200, options.exec?.(app, m, command) ?? { exit_code: 0, stdout: "", stderr: "" });
      }
      return json(404, { error: `no ${method} ${action}` });
    }
    if (kind === "ip_assignments") return method === "GET" ? json(200, { ips: [] }) : json(200, {});
    if (kind === "certificates") return method === "GET" ? json(200, { certificates: [] }) : json(200, {});
    if (kind === "volumes" || kind === "secrets") return method === "GET" ? json(200, []) : json(200, {});
    return json(404, { error: "not found" });
  };

  return {
    http,
    apps,
    machines,
    execs,
    calls,
    machine: (app, name) => list(app).find((m) => m.name === name && !["destroyed", "destroying"].includes(m.state)),
  };
}
