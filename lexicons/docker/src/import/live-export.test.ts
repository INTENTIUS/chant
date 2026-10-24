/**
 * docker live export (#4388): a compose project read from a fake Engine API
 * is mapped back to the compose document it was created from, and
 * `chant import --from` regenerates its services.
 */

import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { liveImportFromPlugins } from "@intentius/chant/cli/commands/import";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { dockerPlugin } from "../plugin";
import { exportResources, projectFor } from "../export-resources";
import { engineAddress, readTar, singleFileText, type DockerEngine } from "./engine";
import {
  composeFromLive,
  configCandidates,
  serviceContainers,
  type ContainerInspect,
  type ImageInspect,
  type LiveService,
} from "./live-export";
import { tarOf } from "./testdata/tar";

const pkgDir = resolve(import.meta.dirname, "../..");

const compose = (project: string, service: string, extra: Record<string, string> = {}) => ({
  "com.docker.compose.project": project,
  "com.docker.compose.service": service,
  "com.docker.compose.container-number": "1",
  "com.docker.compose.oneoff": "False",
  ...extra,
});

const PG_IMAGE: ImageInspect = {
  Config: {
    Cmd: ["postgres"],
    Entrypoint: ["docker-entrypoint.sh"],
    Env: ["PATH=/usr/bin", "PGDATA=/var/lib/postgresql/data"],
    Labels: null,
  },
};

const db: ContainerInspect = {
  Id: "db1",
  Config: {
    Image: "postgres:16-alpine",
    Cmd: ["postgres"],
    Entrypoint: ["docker-entrypoint.sh"],
    Env: ["POSTGRES_DB=app", "PATH=/usr/bin", "PGDATA=/var/lib/postgresql/data"],
    Labels: compose("shop", "db", { "app.kubernetes.io/managed-by": "chant" }),
    Healthcheck: { Test: ["CMD", "pg_isready"], Interval: 5e9, Timeout: 2e9, Retries: 5 },
  },
  HostConfig: { PortBindings: {}, RestartPolicy: { Name: "no" } },
  Mounts: [{ Type: "volume", Name: "shop_pgdata", Destination: "/var/lib/postgresql/data", RW: true }],
  NetworkSettings: { Networks: { shop_default: {} } },
};

const API_IMAGE: ImageInspect = { Config: { Cmd: ["node", "server.js"], Env: ["NODE_ENV=production"], WorkingDir: "/app" } };

const api: ContainerInspect = {
  Id: "api1",
  Config: {
    Image: "shop/api:1.0",
    Cmd: ["node", "server.js", "--settings=/etc/api/settings.json"],
    Env: ["NODE_ENV=production", "DATABASE_URL=postgres://db/app"],
    Labels: compose("shop", "api", { "com.docker.compose.depends_on": "db:service_healthy:false", team: "web" }),
    WorkingDir: "/app",
  },
  HostConfig: {
    PortBindings: { "8080/tcp": [{ HostIp: "", HostPort: "8080" }, { HostIp: "::", HostPort: "8080" }], "9000/udp": [{ HostIp: "127.0.0.1", HostPort: "9000" }] },
    RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
  },
  Mounts: [
    { Type: "bind", Source: "/srv/shop/static", Destination: "/app/static", RW: false },
    { Type: "volume", Name: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Destination: "/tmp/cache", RW: true },
    { Type: "volume", Name: "shared-logs", Destination: "/var/log/api", RW: true },
  ],
  NetworkSettings: { Networks: { shop_default: {}, shop_backend: {} } },
};

const SETTINGS = '{ "feature": true }\n';

function fakeEngine(): { engine: DockerEngine; paths: string[] } {
  const paths: string[] = [];
  const ok = (body: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(body)) });
  const engine: DockerEngine = async (path) => {
    paths.push(path);
    const url = new URL(`http://docker${path}`);
    if (url.pathname === "/containers/json") {
      return ok([
        { Id: "api1", Labels: api.Config!.Labels },
        { Id: "db1", Labels: db.Config!.Labels },
        { Id: "api2", Labels: { ...api.Config!.Labels!, "com.docker.compose.container-number": "2" } },
        { Id: "run1", Labels: { ...api.Config!.Labels!, "com.docker.compose.oneoff": "True" } },
      ]);
    }
    if (url.pathname === "/containers/api1/json") return ok(api);
    if (url.pathname === "/containers/db1/json") return ok(db);
    if (url.pathname === `/images/${encodeURIComponent("shop/api:1.0")}/json`) return ok(API_IMAGE);
    if (url.pathname === "/images/postgres:16-alpine/json") return ok(PG_IMAGE);
    if (url.pathname === "/containers/api1/archive" && url.searchParams.get("path") === "/etc/api/settings.json") {
      return { status: 200, body: tarOf(["settings.json", SETTINGS]) };
    }
    return { status: 404, body: Buffer.from('{"message":"no such thing"}') };
  };
  return { engine, paths };
}

describe("serviceContainers", () => {
  test("one container per service, the lowest number, no one-off runs, only the project's", () => {
    const got = serviceContainers("shop", [
      { Id: "b", Labels: compose("shop", "api", { "com.docker.compose.container-number": "2" }) },
      { Id: "a", Labels: compose("shop", "api") },
      { Id: "r", Labels: compose("shop", "api", { "com.docker.compose.oneoff": "True" }) },
      { Id: "x", Labels: compose("other", "web") },
      { Id: "n", Labels: null },
    ]);
    expect([...got]).toEqual([["api", "a"]]);
  });
});

describe("configCandidates", () => {
  test("absolute file paths the command names, outside every mount", () => {
    expect(
      configCandidates({
        Config: {
          Entrypoint: ["/otelcol-contrib"],
          Cmd: ["--config=/etc/otel/config.yaml", "--set", "x=1", "file:/etc/b.yml", "/data/in.csv", "/usr/bin/run", "--config=/etc/otel/config.yaml"],
        },
        Mounts: [{ Type: "volume", Name: "v", Destination: "/data" }],
      }),
    ).toEqual(["/etc/otel/config.yaml", "/etc/b.yml"]);
  });
});

describe("composeFromLive", () => {
  const live = (name: string, container: ContainerInspect, image: ImageInspect, files: Record<string, string> = {}): LiveService => ({
    name,
    container,
    image,
    files,
  });

  test("drops what the image supplies and what compose writes, and keeps what was declared", () => {
    const doc = composeFromLive("shop", [live("api", api, API_IMAGE, { "/etc/api/settings.json": SETTINGS }), live("db", db, PG_IMAGE)]);
    expect(doc).toEqual({
      services: {
        api: {
          image: "shop/api:1.0",
          command: ["node", "server.js", "--settings=/etc/api/settings.json"],
          environment: { DATABASE_URL: "postgres://db/app" },
          labels: { team: "web" },
          ports: ["8080:8080", "127.0.0.1:9000:9000/udp"],
          restart: "on-failure:3",
          depends_on: { db: { condition: "service_healthy" } },
          volumes: ["/srv/shop/static:/app/static:ro", "/tmp/cache", "shared-logs:/var/log/api"],
          networks: ["default", "backend"],
          configs: [{ source: "api-settings", target: "/etc/api/settings.json" }],
        },
        db: {
          image: "postgres:16-alpine",
          environment: { POSTGRES_DB: "app" },
          labels: { "app.kubernetes.io/managed-by": "chant" },
          healthcheck: { test: ["CMD", "pg_isready"], interval: "5s", timeout: "2s", retries: 5 },
          volumes: ["pgdata:/var/lib/postgresql/data"],
        },
      },
      volumes: { "shared-logs": { external: true }, pgdata: {} },
      networks: { backend: {} },
      configs: { "api-settings": { content: SETTINGS } },
    });
  });

  test("verbatim keeps what the image supplies, never compose's labels", () => {
    const doc = composeFromLive("shop", [live("db", db, PG_IMAGE)], { verbatim: true });
    const svc = (doc.services as Record<string, Record<string, unknown>>).db!;
    expect(svc.command).toEqual(["postgres"]);
    expect(svc.entrypoint).toEqual(["docker-entrypoint.sh"]);
    expect(svc.environment).toEqual({ POSTGRES_DB: "app", PATH: "/usr/bin", PGDATA: "/var/lib/postgresql/data" });
    expect(svc.labels).toEqual({ "app.kubernetes.io/managed-by": "chant" });
  });
});

describe("exportResources against a fake Engine", () => {
  test("reads the project's services and the config files their commands name", async () => {
    const { engine, paths } = fakeEngine();
    const ir = await exportResources({ environment: "shop" }, engine);
    expect(ir.resources.map((r) => `${r.type}/${r.logicalId}`)).toEqual([
      "service/api",
      "service/db",
      "volume/shared-logs",
      "volume/pgdata",
      "network/backend",
      "config/api-settings",
    ]);
    expect(paths.filter((p) => p.includes("/archive"))).toEqual([`/containers/api1/archive?path=${encodeURIComponent("/etc/api/settings.json")}`]);
    expect(paths.some((p) => p.includes("api2") || p.includes("run1"))).toBe(false);
  });

  test("owned keeps only services with chant's marker, and says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { engine, paths } = fakeEngine();
      const ir = await exportResources({ environment: "shop", owned: true }, engine);
      expect(ir.resources.map((r) => `${r.type}/${r.logicalId}`)).toEqual(["service/db", "volume/pgdata"]);
      expect(paths.some((p) => p.includes("/archive"))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("the selector narrows by type and name", async () => {
    const { engine } = fakeEngine();
    const ir = await exportResources({ environment: "shop", selector: { type: "service", name: "db" } }, engine);
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["db"]);
  });

  test("COMPOSE_PROJECT_NAME names the project, else the environment", () => {
    const prev = process.env.COMPOSE_PROJECT_NAME;
    try {
      delete process.env.COMPOSE_PROJECT_NAME;
      expect(projectFor("staging")).toBe("staging");
      process.env.COMPOSE_PROJECT_NAME = "shop";
      expect(projectFor("staging")).toBe("shop");
    } finally {
      if (prev === undefined) delete process.env.COMPOSE_PROJECT_NAME;
      else process.env.COMPOSE_PROJECT_NAME = prev;
    }
  });

  test("a failed listing is an error, not an empty project", async () => {
    const engine: DockerEngine = async () => ({ status: 500, body: Buffer.from("daemon down") });
    await expect(exportResources({ environment: "shop" }, engine)).rejects.toThrow(/compose project shop failed \(500\): daemon down/);
  });

  test("chant import --from regenerates the project's services", async () => {
    const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
    try {
      writeFileSync(join(dir, "package.json"), '{ "name": "docker-live", "private": true, "type": "module" }\n');
      const { engine } = fakeEngine();
      const plugin: LexiconPlugin = { ...dockerPlugin, exportResources: (options) => exportResources(options, engine) };
      const result = await liveImportFromPlugins([plugin], { environment: "shop", output: join(dir, "src"), lexicon: "docker", force: true });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      const main = result.generatedFiles.map((f) => readFileSync(join(dir, "src", f), "utf-8")).join("\n");
      expect(main).toContain("export const api = new Service(");
      expect(main).toContain('image: "postgres:16-alpine"');
      expect(main).toContain('composeKey("api-settings", new DockerConfig(');
      expect(main).toContain(JSON.stringify(SETTINGS));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine", () => {
  test("DOCKER_HOST: unix socket, plain tcp, else the default socket", () => {
    expect(engineAddress("unix:///run/user/1000/docker.sock")).toEqual({ socketPath: "/run/user/1000/docker.sock" });
    expect(engineAddress("tcp://10.0.0.5:2375")).toEqual({ host: "10.0.0.5", port: 2375 });
    expect(engineAddress("")).toEqual({ socketPath: "/var/run/docker.sock" });
    expect(() => engineAddress("ssh://me@host")).toThrow(/not a unix:\/\/ or tcp:\/\//);
  });

  test("an archive of one text file gives its text; a directory, several files or bytes do not", () => {
    expect(singleFileText(tarOf(["config.yaml", "a: 1\n"]))).toBe("a: 1\n");
    expect(singleFileText(tarOf(["conf.d/", null], ["conf.d/a.yaml", "a: 1\n"]))).toBeUndefined();
    expect(readTar(tarOf(["x", "y".repeat(700)]))[0]!.data.length).toBe(700);
  });
});
