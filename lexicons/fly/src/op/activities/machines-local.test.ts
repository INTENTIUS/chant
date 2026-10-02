import { afterEach, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalMachines, serveLocalMachines } from "./machines-local";
import { parseArgs } from "./machines-local-cli";
import { flyMachineExec, flyMachineRelease, flyMachineRestore, flyMachineStop, type MachineFile } from "./machine-release";
import type { FlyPlan } from "./fly-apply";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../../..");
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;

/** A tiny app: serves page.txt and, when a migration has written it, /data/state. */
const SERVER = `
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
const state = () => (existsSync(process.env.DATA + "/state") ? readFileSync(process.env.DATA + "/state", "utf8").trim() : "none");
createServer((req, res) => res.end(readFileSync(new URL("./page.txt", import.meta.url), "utf8").trim() + " " + state())).listen(Number(process.env.PORT), "127.0.0.1");
`;

const b64 = (s: string) => Buffer.from(s).toString("base64");
const files = (page: string): MachineFile[] => [
  { guest_path: "/srv/app/server.mjs", raw_value: b64(SERVER) },
  { guest_path: "/srv/app/page.txt", raw_value: b64(page) },
];
const config = (page: string) => ({
  image: "node:22-slim",
  env: { PORT: "8080", DATA: "/data" },
  services: [{ protocol: "tcp", internal_port: 8080 }],
  mounts: [{ volume: "data", path: "/data" }],
  files: files(page),
  init: { cmd: ["sh", "-c", "cd /srv/app && exec node server.mjs"] },
});

/** Is `pid` running, as `ps` sees it? */
const alive = (pid: number) => spawnSync("ps", ["-p", String(pid)]).status === 0;
const get = async (url: string) => (await fetch(url)).text();

let dirs: string[] = [];
let open: Array<{ close(): Promise<void> }> = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "chant-machines-local-")));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const o of open) await o.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  open = [];
  dirs = [];
});

describe("the running mode of the local Machines API (#2831)", () => {
  test("runs a Machine's files and command, serves it, restarts it on a new config, and stops it with no process left", { timeout: 60_000 }, async () => {
    const root = tmp();
    const served = await serveLocalMachines({ port: 0, root, log: join(root, "machines.log") });
    open.push(served);
    const machines = served.machines;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${served.url}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };

    expect((await call("GET", "/_mudflaps/health")).status).toBe(200);
    await call("POST", "/v1/apps", { app_name: "shop", org_slug: "personal" });
    const created = await call("POST", "/v1/apps/shop/machines", { name: "web", config: config("A") });
    expect(created.status).toBe(200);
    const id = created.json.id as string;

    const url = machines.endpoint("shop", "web");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await get(url!)).toBe("A none");
    // The files are under root, the guest paths the command named mapped there.
    expect(readFileSync(join(root, "srv/app/page.txt"), "utf8")).toBe("A");
    const [first] = machines.processes();
    expect(first).toMatchObject({ app: "shop", name: "web", id });
    expect(alive(first.pid!)).toBe(true);

    // An exec runs in the Machine's env, against the Volume the app reads.
    const exec = await call("POST", `/v1/apps/shop/machines/${id}/exec`, { command: ["sh", "-c", "echo migrated > $DATA/state && echo done"], timeout: 30 });
    expect(exec.json).toMatchObject({ exit_code: 0, stdout: "done\n" });
    expect(await get(url!)).toBe("A migrated");

    // A new config is a new instance: the process starts again on the new files, on the same port, and the Volume is kept.
    const updated = await call("POST", `/v1/apps/shop/machines/${id}`, { config: config("B") });
    expect(updated.json.instance_id).not.toBe(created.json.instance_id);
    const [second] = machines.processes();
    expect(second.pid).not.toBe(first.pid);
    expect(alive(first.pid!)).toBe(false);
    expect(machines.endpoint("shop", "web")).toBe(url);
    expect(await get(url!)).toBe("B migrated");

    // A restart runs it again.
    await call("POST", `/v1/apps/shop/machines/${id}/restart`);
    const [third] = machines.processes();
    expect(third.pid).not.toBe(second.pid);
    expect(alive(second.pid!)).toBe(false);
    expect(await get(url!)).toBe("B migrated");

    // A stop leaves nothing running and removes the instance's files; the Volume stays.
    await call("POST", `/v1/apps/shop/machines/${id}/stop`);
    expect(machines.processes()).toEqual([]);
    expect(alive(third.pid!)).toBe(false);
    expect(machines.endpoint("shop", "web")).toBeUndefined();
    expect(existsSync(join(root, "srv/app/page.txt"))).toBe(false);
    expect(readFileSync(join(root, "data/state"), "utf8")).toBe("migrated\n");

    // Start, then delete: running again, then gone.
    await call("POST", `/v1/apps/shop/machines/${id}/start`);
    const [fourth] = machines.processes();
    expect(await get(url!)).toBe("B migrated");
    await call("DELETE", `/v1/apps/shop/machines/${id}`);
    expect(machines.processes()).toEqual([]);
    expect(alive(fourth.pid!)).toBe(false);
  });

  test("the release activities: release A, a migration, release B, then A restored serves A again", { timeout: 60_000 }, async () => {
    const root = tmp();
    const machines = createLocalMachines({ root });
    open.push(machines);
    const endpoint = "http://flaps.local";
    const wait = { intervalMs: 20, deadlineMs: 10_000 };
    const plan: FlyPlan = {
      shop: { endpoint: "/v1/apps", method: "POST", body: { app_name: "shop", org_slug: "personal" } },
      web: {
        endpoint: "/v1/apps/shop/machines",
        method: "POST",
        body: { name: "web", config: { image: "node:22-slim", env: { PORT: "8080", DATA: "/data" }, services: [{ internal_port: 8080 }], mounts: [{ volume: "data", path: "/data" }] } },
      },
    };
    const release = (page: string, digest: string) =>
      flyMachineRelease({ plan, endpoint, release: { digest }, files: files(page), cmd: "cd /srv/app && exec node server.mjs", wait }, undefined, machines.http);

    const a = await release("A", "sha256:a");
    const url = machines.endpoint("shop", "web")!;
    expect(await get(url)).toBe("A none");
    await flyMachineExec({ app: "shop", machine: "web", command: "echo v1 > /data/state", endpoint }, undefined, machines.http);
    expect(await get(url)).toBe("A v1");

    await release("B", "sha256:b");
    expect(await get(url)).toBe("B v1");

    await flyMachineRestore({ app: "shop", machine: "web", config: a.config, endpoint, wait }, undefined, machines.http);
    expect(await get(url)).toBe("A v1");

    const [p] = machines.processes();
    await flyMachineStop({ app: "shop", machine: "web", endpoint, wait }, undefined, machines.http);
    expect(machines.processes()).toEqual([]);
    expect(alive(p.pid!)).toBe(false);
  });

  test("a process that exits on its own leaves its Machine stopped", { timeout: 30_000 }, async () => {
    const machines = createLocalMachines({ root: tmp(), log: join(tmp(), "log") });
    open.push(machines);
    await machines.http("POST", "http://f/v1/apps", { app_name: "shop" });
    const r = await machines.http("POST", "http://f/v1/apps/shop/machines", { name: "web", config: { init: { cmd: ["sh", "-c", "exit 3"] } } });
    const id = JSON.parse(r.text).id as string;
    for (let i = 0; i < 100 && machines.machine("shop", "web")!.state === "started"; i++) await new Promise((ok) => setTimeout(ok, 20));
    expect(machines.machine("shop", "web")!.state).toBe("stopped");
    expect(machines.processes()).toEqual([]);
    expect(JSON.parse((await machines.http("GET", `http://f/v1/apps/shop/machines/${id}/wait?state=started`)).text)).toEqual({ ok: false });
  });

  test("with no root, guest paths are host paths", async () => {
    const dir = tmp();
    const machines = createLocalMachines({ log: join(dir, "log") });
    open.push(machines);
    await machines.http("POST", "http://f/v1/apps", { app_name: "shop" });
    await machines.http("POST", "http://f/v1/apps/shop/machines", {
      name: "web",
      config: { files: [{ guest_path: join(dir, "a/b.txt"), raw_value: b64("hi") }] },
    });
    expect(readFileSync(join(dir, "a/b.txt"), "utf8")).toBe("hi");
  });

  for (const how of ["SIGTERM", "SIGINT", "exit"] as const) {
    test(`a Machine's process does not outlive its host process (${how})`, { timeout: 60_000 }, async () => {
      const root = tmp();
      const script = join(root, "host.mts");
      writeFileSync(
        script,
        `import { createLocalMachines } from ${JSON.stringify(join(here, "machines-local.ts"))};
const m = createLocalMachines({ root: ${JSON.stringify(root)}, log: ${JSON.stringify(join(root, "log"))} });
await m.http("POST", "http://f/v1/apps", { app_name: "shop" });
await m.http("POST", "http://f/v1/apps/shop/machines", { name: "web", config: { init: { cmd: ["sh", "-c", "sleep 300 & exec sleep 301"] } } });
console.log(JSON.stringify(m.processes()[0].pid));
${how === "exit" ? "setTimeout(() => process.exit(0), 100);" : "setInterval(() => undefined, 1000);"}
`,
      );
      const host = spawn(process.execPath, ["--import", tsxLoader, script], {
        stdio: ["ignore", "pipe", "inherit"],
        // tsx's on-disk cache can stall for seconds under load; this script is too small to need it.
        env: { ...process.env, TSX_DISABLE_CACHE: "1" },
      });
      const pid = await new Promise<number>((ok) => host.stdout!.once("data", (d) => ok(Number(String(d).trim()))));
      expect(alive(pid)).toBe(true);
      const exited = new Promise((ok) => host.once("exit", ok));
      if (how !== "exit") host.kill(how);
      await exited;
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 20));
      expect(alive(pid)).toBe(false);
      // Nor does anything the command started in its group.
      const left = spawnSync("pgrep", ["-g", String(pid)], { encoding: "utf8" }).stdout.trim();
      expect(left).toBe("");
    });
  }
});

describe("machines-local-cli args", () => {
  test("--publish takes one port for every Machine, or name=port", () => {
    expect(parseArgs([])).toMatchObject({ port: 4280, publish: undefined });
    expect(parseArgs(["--listen", "4999", "--root", "/r", "--publish", "8080"])).toMatchObject({ port: 4999, root: "/r", publish: 8080 });
    const { publish } = parseArgs(["--publish", "web=8080", "--publish", "shop/api=9090"]);
    const fn = publish as (app: string, m: { name: string }) => number | undefined;
    expect(fn("shop", { name: "web" })).toBe(8080);
    expect(fn("shop", { name: "api" })).toBe(9090);
    expect(fn("shop", { name: "other" })).toBeUndefined();
    expect(() => parseArgs(["--publish"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--nope", "1"])).toThrow(/unknown flag/);
  });
});
