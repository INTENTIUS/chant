/**
 * Docker helpers for the grafana lexicon's end-to-end tests: a Grafana of a
 * given release with provisioning mounted, a Prometheus preloaded with
 * series, and a private network between them.
 *
 * Every name carries the process id and a random suffix, every host port is
 * picked by Docker, and `DockerScope.cleanup()` removes whatever the scope
 * started, so two runs on one machine (or a run and a crashed run) don't
 * collide. Tests call `cleanup()` from `afterAll`, which vitest runs even
 * when a test or `beforeAll` failed.
 *
 * Without a running Docker daemon `dockerAvailable()` is false and the
 * suites skip.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The Grafana releases the e2e runs against. `CHANT_GRAFANA_IMAGES` (comma-separated) overrides them. */
export const GRAFANA_IMAGES: string[] = (process.env.CHANT_GRAFANA_IMAGES ?? "grafana/grafana:12.4.11,grafana/grafana:13.2.2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The Prometheus the query tests seed; its image also carries the `promtool` used to backfill. */
export const PROMETHEUS_IMAGE = process.env.CHANT_PROMETHEUS_IMAGE ?? "prom/prometheus:v3.15.0";

const ADMIN_AUTH = `Basic ${Buffer.from("admin:admin").toString("base64")}`;

function docker(args: string[], opts: { input?: string } = {}): string {
  return execFileSync("docker", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...(opts.input !== undefined ? { input: opts.input } : {}) }).trim();
}

/** Whether a Docker daemon answers. */
export function dockerAvailable(): boolean {
  try {
    docker(["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

/** Poll `fn` once a second until it returns something other than `undefined`. */
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

/** The host port Docker published for a container port. */
function hostPort(container: string, port: number): string {
  const line = docker(["port", container, `${port}/tcp`]).split("\n")[0];
  return line.split(":").pop()!;
}

export interface ApiResponse {
  status: number;
  body: any;
}

export interface GrafanaContainer {
  name: string;
  image: string;
  /** `http://127.0.0.1:<port>` */
  base: string;
  /** A JSON request as the admin user. */
  api(path: string, init?: RequestInit): Promise<ApiResponse>;
}

export interface PrometheusContainer {
  name: string;
  base: string;
}

export interface StartGrafanaOptions {
  image: string;
  /** Mounted read-only at /etc/grafana/provisioning. */
  provisioningDir?: string;
  /** Mounted read-only at /var/lib/grafana/dashboards, where chant's provider config points. */
  dashboardsDir?: string;
  /** A network made by `DockerScope.network()`. */
  network?: string;
  env?: Record<string, string>;
}

export interface StartPrometheusOptions {
  /** A network made by `DockerScope.network()`. */
  network?: string;
  /** The hostname other containers on the network reach it by (default `prometheus`). */
  alias?: string;
  /**
   * OpenMetrics text (with timestamps, ending `# EOF`) backfilled into the
   * TSDB with `promtool tsdb create-blocks-from openmetrics` before the
   * server starts.
   */
  openMetrics?: string;
  image?: string;
}

/**
 * The containers, networks and temp directories one suite starts, removed
 * together by `cleanup()`.
 */
export class DockerScope {
  readonly id: string;
  private readonly containers: string[] = [];
  private readonly networks: string[] = [];
  private readonly dirs: string[] = [];

  constructor(label: string) {
    this.id = `chant-${label}-${process.pid}-${randomBytes(3).toString("hex")}`;
  }

  /** A fresh temp directory, removed on cleanup. */
  tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), `${this.id}-`));
    // Readable by the images' own users (grafana is uid 472) on a Linux host.
    chmodSync(dir, 0o755);
    this.dirs.push(dir);
    return dir;
  }

  /** A user-defined bridge network, so containers reach each other by alias. */
  network(): string {
    const name = `${this.id}-net`;
    docker(["network", "create", name]);
    this.networks.push(name);
    return name;
  }

  /** Start a Grafana and wait until `/api/health` answers. */
  async grafana(opts: StartGrafanaOptions): Promise<GrafanaContainer> {
    const name = `${this.id}-grafana-${this.containers.length}`;
    const args = ["run", "-d", "--name", name, "-p", "127.0.0.1::3000"];
    if (opts.network) args.push("--network", opts.network);
    const env = {
      GF_SECURITY_ADMIN_PASSWORD: "admin",
      GF_ANALYTICS_REPORTING_ENABLED: "false",
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
      GF_PLUGINS_PREINSTALL_DISABLED: "true",
      ...opts.env,
    };
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    if (opts.provisioningDir) args.push("-v", `${opts.provisioningDir}:/etc/grafana/provisioning:ro`);
    if (opts.dashboardsDir) args.push("-v", `${opts.dashboardsDir}:/var/lib/grafana/dashboards:ro`);
    this.containers.push(name);
    docker([...args, opts.image]);
    const base = `http://127.0.0.1:${hostPort(name, 3000)}`;
    const api = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: ADMIN_AUTH, "content-type": "application/json", ...(init?.headers ?? {}) },
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON; keep the text
      }
      return { status: res.status, body };
    };
    await waitFor(`${opts.image} to answer`, async () => ((await fetch(`${base}/api/health`)).ok ? true : undefined));
    return { name, image: opts.image, base, api };
  }

  /**
   * Start a Prometheus, backfilled first when `openMetrics` is given, and
   * wait until it is ready.
   *
   * The series go in with the image's own `promtool` in the same container,
   * before `prometheus` starts, so nothing needs promtool on the host and no
   * host directory needs to be writable by the image's user.
   */
  async prometheus(opts: StartPrometheusOptions = {}): Promise<PrometheusContainer> {
    const name = `${this.id}-prometheus-${this.containers.length}`;
    const image = opts.image ?? PROMETHEUS_IMAGE;
    const args = ["create", "--name", name, "-p", "127.0.0.1::9090"];
    if (opts.network) args.push("--network", opts.network, "--network-alias", opts.alias ?? "prometheus");
    const serve = "exec prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus --storage.tsdb.retention.time=30d";
    const script = opts.openMetrics ? `promtool tsdb create-blocks-from openmetrics /tmp/seed.om /prometheus >/tmp/backfill.log && ${serve}` : serve;
    args.push("--entrypoint", "/bin/sh", image, "-c", script);
    this.containers.push(name);
    docker(args);
    if (opts.openMetrics) {
      const dir = this.tempDir();
      writeFileSync(join(dir, "seed.om"), opts.openMetrics);
      // docker cp keeps the host mode and owner; the image runs as nobody.
      chmodSync(join(dir, "seed.om"), 0o644);
      docker(["cp", join(dir, "seed.om"), `${name}:/tmp/seed.om`]);
    }
    docker(["start", name]);
    let base = "";
    let exited = "";
    await waitFor("Prometheus to be ready", async () => {
      if (docker(["inspect", "-f", "{{.State.Running}}", name]) !== "true") {
        exited = `Prometheus exited:\n${this.logs(name, 20)}`;
        return exited;
      }
      base ||= `http://127.0.0.1:${hostPort(name, 9090)}`;
      return (await fetch(`${base}/-/ready`)).ok ? "" : undefined;
    });
    if (exited) throw new Error(exited);
    return { name, base };
  }

  /** The last lines of a container's log, for a failure message. */
  logs(name: string, lines = 40): string {
    try {
      return execFileSync("docker", ["logs", "--tail", String(lines), name], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return "";
    }
  }

  /** Remove every container (with its anonymous volumes), network and temp directory this scope made. Never throws. */
  cleanup(): void {
    for (const c of this.containers.splice(0)) {
      try {
        docker(["rm", "-f", "-v", c]);
      } catch {
        // already gone
      }
    }
    for (const n of this.networks.splice(0)) {
      try {
        docker(["network", "rm", n]);
      } catch {
        // already gone
      }
    }
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}
