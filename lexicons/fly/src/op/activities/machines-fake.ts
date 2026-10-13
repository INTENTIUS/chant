/**
 * An in-memory Fly Machines (flaps) API, as a {@link FlyHttp} (#2736).
 *
 * The twin of ./sprites-fake.ts for the Machines side: the endpoints the
 * applier (./fly-apply.ts) and the release activities (./machine-release.ts)
 * call, answered from memory with the response shapes flaps and mudflaps use.
 * Unit tests inject it where the default client would reach the network; the
 * docker-gated tests run the same activities against the pinned mudflaps.
 * It runs nothing; ./machines-local.ts is the opt-in mode that runs each
 * started Machine's files and command on this host (#2831).
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
  /** Each app's certificate hostnames, in creation order. */
  certs: Map<string, string[]>;
  /** Every exec, in order: the app, the machine id and the command. */
  execs: Array<{ app: string; id: string; command: string[] }>;
  /** Every call, as `METHOD path` (no base, no query). */
  calls: string[];
  /** The live machine named `name` in `app`, if any. */
  machine(app: string, name: string): FakeMachine | undefined;
}

export interface MachinesFakeOptions {
  /** Answer an exec. Default: exit 0 with no output. The running mode (./machines-local.ts) answers it by running the command. */
  exec?: (app: string, machine: FakeMachine, command: string[]) => FakeExecResult | Promise<FakeExecResult>;
  /** The state a created or updated machine settles in. Default `started`. */
  settle?: (machine: FakeMachine) => string;
}

const json = (status: number, body: unknown) => ({ status, text: body === undefined ? "" : JSON.stringify(body) });

/** Fly's certificate-list page size: 25 when no `limit` is given, 500 at most. */
export const CERT_PAGE_DEFAULT = 25;
export const CERT_PAGE_MAX = 500;
// The fake's cursor is an offset in disguise; callers must treat it as opaque.
const offsetCursor = (offset: number): string => Buffer.from(`certs:${offset}`).toString("base64url");
const cursorOffset = (cursor: string): number | undefined => {
  const m = /^certs:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
  return m ? Number(m[1]) : undefined;
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(10, "0")}`;

/**
 * A fresh in-memory flaps. Like the real API, a bare DELETE on a machine that
 * is not stopped, suspended, failed or created answers 412; `?force=true`
 * destroys it in any state.
 */
export function createMachinesFake(options: MachinesFakeOptions = {}): MachinesFake {
  const apps = new Set<string>();
  const machines = new Map<string, FakeMachine[]>();
  const certs = new Map<string, string[]>();
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
        certs.delete(app);
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
          // Real flaps destroys a running machine only with ?force=true and
          // answers a bare DELETE with 412 (#3115). mudflaps does not (yet).
          if (searchParams.get("force") !== "true" && !["stopped", "suspended", "failed", "created"].includes(m.state)) {
            return json(412, {
              error: "failed_precondition: unable to destroy machine, not currently stopped, suspended, failed or created",
            });
          }
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
        return json(200, (await options.exec?.(app, m, command)) ?? { exit_code: 0, stdout: "", stderr: "" });
      }
      return json(404, { error: `no ${method} ${action}` });
    }
    if (kind === "ip_assignments") return method === "GET" ? json(200, { ips: [] }) : json(200, {});
    if (kind === "certificates") return certificates(app, method, seg.slice(4), b, searchParams);
    if (kind === "volumes" || kind === "secrets") return method === "GET" ? json(200, []) : json(200, {});
    return json(404, { error: "not found" });
  };

  // Certificates, as the real API routes them (#3114): listed at
  // `.../certificates`, created only at `.../certificates/acme`, read and
  // deleted at `.../certificates/{hostname}`. A POST to the bare list path is
  // the 404 flaps gives, so an applier that posts there fails here too.
  // The list pages like Fly's (#3224): `limit` defaults to 25 and is capped at
  // 500, and `next_cursor` is present while certificates remain. mudflaps
  // returns the whole list in one page (INTENTIUS/mudflaps#71).
  function certificates(app: string, method: string, rest: string[], b: Record<string, unknown>, q: URLSearchParams) {
    const hostnames = certs.get(app) ?? [];
    const detail = (hostname: string) => ({ hostname, acme_requested: true, configured: false, status: "pending" });
    if (rest.length === 0) {
      if (method !== "GET") return { status: 404, text: "404 page not found" };
      const limit = Math.min(CERT_PAGE_MAX, Math.max(1, Number(q.get("limit")) || CERT_PAGE_DEFAULT));
      const cursor = q.get("cursor");
      const from = cursor === null ? 0 : cursorOffset(cursor);
      if (from === undefined) return json(400, { error: `invalid cursor ${cursor}` });
      const page = hostnames.slice(from, from + limit);
      const more = from + limit < hostnames.length;
      return json(200, {
        certificates: page.map(detail),
        ...(more ? { next_cursor: offsetCursor(from + limit) } : {}),
        total_count: hostnames.length,
      });
    }
    if (rest.length === 1 && rest[0] === "acme" && method === "POST") {
      const hostname = typeof b.hostname === "string" ? b.hostname : "";
      if (!hostname) return json(422, { error: "hostname is required" });
      if (hostnames.includes(hostname)) return json(422, { error: `certificate ${hostname} already exists` });
      certs.set(app, [...hostnames, hostname]);
      return json(201, detail(hostname));
    }
    if (rest.length === 1 && (method === "GET" || method === "DELETE")) {
      const hostname = rest[0];
      if (!hostnames.includes(hostname)) return json(404, { error: "certificate not found" });
      if (method === "GET") return json(200, detail(hostname));
      certs.set(app, hostnames.filter((h) => h !== hostname));
      return json(204, undefined);
    }
    return { status: 404, text: "404 page not found" };
  }

  return {
    http,
    apps,
    machines,
    certs,
    execs,
    calls,
    machine: (app, name) => list(app).find((m) => m.name === name && !["destroyed", "destroying"].includes(m.state)),
  };
}
