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
  /** When the machine was last created or updated (RFC 3339), as flaps reports it. */
  updated_at?: string;
}

/** One volume the fake holds, as flaps lists it. */
export interface FakeVolume {
  id: string;
  name: string;
  region?: string;
  size_gb?: number;
  state: string;
  /** The Machine whose config mounts it by id; null when none does. */
  attached_machine_id: string | null;
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
  /** Each app's volumes, in creation order, with ids `vol_...` (#4717). */
  volumes: Map<string, FakeVolume[]>;
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
  /** The clock a create or update stamps `updated_at` with. Default: the wall clock. */
  now?: () => Date;
  /**
   * The Fly checks a machine reports each time it is read (#4719), as the
   * Machines API's `checks`: asked on every GET of the machine or its list.
   * Default: none.
   */
  checks?: (app: string, machine: FakeMachine) => FakeCheck[] | undefined;
}

/** One Fly check's status on a machine, as the Machines API reports it. */
export interface FakeCheck {
  name: string;
  status: "passing" | "warning" | "critical";
  output?: string;
  /** When the check last reported (RFC 3339). */
  updated_at?: string;
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
  const volumes = new Map<string, FakeVolume[]>();
  const certs = new Map<string, string[]>();
  const execs: MachinesFake["execs"] = [];
  const calls: string[] = [];
  const settle = options.settle ?? (() => "started");
  const stamp = () => (options.now?.() ?? new Date()).toISOString();
  const list = (app: string) => machines.get(app) ?? [];
  const find = (app: string, id: string) => list(app).find((m) => m.id === id);
  const withChecks = (app: string, m: FakeMachine) => {
    const checks = options.checks?.(app, m);
    return checks ? { ...m, checks } : m;
  };
  const vols = (app: string) => volumes.get(app) ?? [];
  // A volume is attached to the Machine whose config mounts its id, as Fly
  // attaches it. A mount naming no volume id attaches nothing.
  const attach = (app: string, m: FakeMachine | undefined, id: string) => {
    const mounted = new Set(
      ((m?.config.mounts as Array<{ volume?: unknown }> | undefined) ?? []).map((x) => x.volume).filter((v) => typeof v === "string"),
    );
    for (const v of vols(app)) {
      if (v.attached_machine_id === id && !mounted.has(v.id)) v.attached_machine_id = null;
      if (m && mounted.has(v.id)) v.attached_machine_id = id;
    }
  };

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
        volumes.delete(app);
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
        if (method === "GET") return json(200, list(app).map((m) => withChecks(app, m)));
        if (method === "POST") {
          const m: FakeMachine = {
            id: nextId("m"),
            name: String(b.name ?? ""),
            state: "created",
            instance_id: nextId("I"),
            config: structuredClone((b.config ?? {}) as FakeMachine["config"]),
            updated_at: stamp(),
          };
          // skip_launch: the Machine is created and not booted (#4696).
          m.state = b.skip_launch === true ? "created" : settle(m);
          machines.set(app, [...list(app), m]);
          attach(app, m, m.id);
          return json(200, m);
        }
      }
      const m = id ? find(app, id) : undefined;
      if (!m) return action === "wait" ? json(200, { ok: true }) : json(404, { error: "machine not found" });
      if (!action) {
        if (method === "GET") return json(200, withChecks(app, m));
        if (method === "POST") {
          m.config = structuredClone((b.config ?? {}) as FakeMachine["config"]);
          m.instance_id = nextId("I");
          m.updated_at = stamp();
          attach(app, m, m.id);
          // skip_launch: the new config isn't started (#4696). A Machine that
          // never ran stays created; one that ran is stopped.
          m.state = b.skip_launch === true ? (m.state === "created" ? "created" : "stopped") : settle(m);
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
          attach(app, undefined, m.id);
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
    if (kind === "volumes") return volumeCall(app, method, seg[4], b);
    if (kind === "secrets") return method === "GET" ? json(200, []) : json(200, {});
    return json(404, { error: "not found" });
  };

  // Volumes (#4717): created with a `vol_` id, listed with their region and
  // the Machine they are attached to, read and deleted by id.
  function volumeCall(app: string, method: string, id: string | undefined, b: Record<string, unknown>) {
    if (!id) {
      if (method === "GET") return json(200, vols(app));
      if (method === "POST") {
        const v: FakeVolume = {
          id: nextId("vol_"),
          name: String(b.name ?? ""),
          ...(typeof b.region === "string" ? { region: b.region } : {}),
          ...(typeof b.size_gb === "number" ? { size_gb: b.size_gb } : {}),
          state: "created",
          attached_machine_id: null,
        };
        volumes.set(app, [...vols(app), v]);
        return json(200, v);
      }
    }
    const v = vols(app).find((x) => x.id === id);
    if (!v) return json(404, { error: "volume not found" });
    if (method === "GET") return json(200, v);
    if (method === "DELETE") {
      volumes.set(app, vols(app).filter((x) => x !== v));
      return json(200, { ...v, state: "destroyed" });
    }
    return json(404, { error: `no ${method} on a volume` });
  }

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
    volumes,
    certs,
    execs,
    calls,
    machine: (app, name) => list(app).find((m) => m.name === name && !["destroyed", "destroying"].includes(m.state)),
  };
}
