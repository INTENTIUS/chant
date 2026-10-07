/**
 * #2880 — a box's services declared in its box block, observed, restarted
 * and applied through sprite-env with `box: true`.
 *
 * The workspace here has one box member, `box/`, whose block declares `app`,
 * `hud` (needing `app`) and an optional `site`. `sprite-env` is a stand-in
 * with a sprite's command line: `services list` prints JSON in the shape a
 * sprite's does (`[{ name, cmd, needs, http_port, state: { status } }]`),
 * `create` refuses a name it has and a `needs` it doesn't, and every call is
 * appended to a log the tests read. A small HTTP server answers each
 * service's health URL with 200 while the service runs.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ConvergeOp, eq, loadActivities, run, runOpLocally, when, type ActivityFn, type OpConfig, type ResourceSymptom } from "@intentius/chant/op";
import { convergeTick } from "@intentius/chant/op/activities";
import { readConvergeLedger } from "@intentius/chant/lifecycle/converge-ledger";
import { spriteApplyServices, listedServiceDiffers, parseServiceDefinitions, spriteEnvCreateArgs } from "./sprite-config";
import { spriteServiceRestart, spriteServicesObserve } from "./sprite-service-converge";
import { expandServiceCommand, serviceCommandArgv } from "./box-services";
import { spriteServicesObserve as observeStep, spriteServiceRestart as restartStep } from "../builders";

let root: string;
let boxDir: string;
let state: string;
let calls: string;
let server: Server;
let port = 0;
const saved = { PATH: process.env.PATH, cwd: process.cwd(), STATE: process.env.FAKE_SPRITE_STATE, RESOURCE: process.env.CHANT_CONVERGE_RESOURCE, BOX_HOME: process.env.BOX_HOME };

const SPRITE_ENV = `#!/usr/bin/env node
const { appendFileSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.FAKE_SPRITE_STATE;
const argv = process.argv.slice(2);
appendFileSync(join(dir, "..", "calls"), argv.join(" ") + "\\n");
const [group, verb, name, ...rest] = argv;
if (group !== "services") process.exit(2);
const file = (n) => join(dir, n + ".json");
const read = (n) => JSON.parse(readFileSync(file(n), "utf8"));
const fail = (m) => { console.error("sprite-env: " + m); process.exit(1); };
if (verb === "list") {
  const out = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return { name: s.name, cmd: s.cmd, args: s.args, needs: s.needs, http_port: s.httpPort, state: { name: s.name, status: s.status } };
  });
  console.log(JSON.stringify(out));
} else if (verb === "create") {
  if (existsSync(file(name))) fail("service " + name + " already exists");
  const s = { name, cmd: null, args: [], needs: [], httpPort: 0, status: "running" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-stream") continue;
    const v = rest[++i];
    if (a === "--cmd") s.cmd = v;
    else if (a === "--args") s.args = v.split(",");
    else if (a === "--needs") s.needs = v.split(",");
    else if (a === "--http-port") s.httpPort = Number(v);
    else if (a === "--duration") s.duration = v;
    else fail("unknown option " + a);
  }
  for (const n of s.needs) if (!existsSync(file(n))) fail("service " + name + " needs " + n + ", which does not exist");
  if (s.httpPort > 0) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      if (JSON.parse(readFileSync(join(dir, f), "utf8")).httpPort > 0) fail("another service already has an HTTP port configured (409)");
    }
  }
  writeFileSync(file(name), JSON.stringify(s));
} else if (verb === "delete") {
  if (!existsSync(file(name))) fail("no service " + name);
  rmSync(file(name));
} else if (["restart", "start", "stop"].includes(verb)) {
  if (!existsSync(file(name))) fail("no service " + name);
  const s = read(name);
  s.status = verb === "stop" ? "stopped" : "running";
  writeFileSync(file(name), JSON.stringify(s));
} else process.exit(2);
`;

// chant run <op>, as far as a converge dispatch goes: the restart the dispatched Op runs.
const CHANT = `#!/bin/sh
echo "$2 $CHANT_CONVERGE_RESOURCE" >> "$FAKE_SPRITE_STATE/../dispatched"
exec sprite-env services restart "$CHANT_CONVERGE_RESOURCE"
`;

const health = (name: string) => `http://127.0.0.1:${port}/${name}`;

function declare(services: unknown[]): void {
  writeFileSync(
    join(root, "chant.workspace.json"),
    JSON.stringify(
      {
        name: "acme",
        schema: 1,
        members: [{ name: "box", dir: "box", kind: "other", because: "the box's steward and its Ops", box: { services } }],
      },
      null,
      2,
    ),
  );
}

const SERVICES = () => [
  { name: "app", cmd: "${BOX_HOME}/run-app.sh", duration: "3s", health: health("app") },
  { name: "hud", cmd: "${BOX_HOME}/run-daemon.sh", needs: ["app"], httpPort: 8080, duration: "3s", health: health("hud") },
  { name: "site", cmd: "${BOX_HOME}/run-site.sh", health: health("site"), optional: true },
];

const listed = () => new Map(JSON.parse(spawnSync("sprite-env", ["services", "list"], { encoding: "utf8" }).stdout).map((s: { name: string }) => [s.name, s]));
const takeCalls = (): string[] => {
  const text = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  rmSync(calls, { force: true });
  return text.split("\n").filter((l) => l && l !== "services list");
};
const setStatus = (name: string, status: string) => {
  const f = join(state, `${name}.json`);
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), status }));
};

function git(...args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "chant-box-services-"));
  boxDir = join(root, "box");
  const bin = join(root, ".bin");
  state = join(root, ".state", "services");
  calls = join(root, ".state", "calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(boxDir, { recursive: true });
  writeFileSync(join(bin, "sprite-env"), SPRITE_ENV);
  writeFileSync(join(bin, "chant"), CHANT);
  chmodSync(join(bin, "sprite-env"), 0o755);
  chmodSync(join(bin, "chant"), 0o755);
  server = createServer((req, res) => {
    const name = (req.url ?? "/").slice(1);
    const f = join(state, `${name}.json`);
    const up = existsSync(f) && JSON.parse(readFileSync(f, "utf8")).status === "running";
    res.writeHead(up ? 200 : 503).end(up ? "ok" : "down");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_SPRITE_STATE = state;
  process.env.BOX_HOME = "/home/sprite/box";
  git("init", "-q", "-b", "main");
  git("config", "user.email", "box@example.com");
  git("config", "user.name", "Box Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(boxDir, "chant.config.json"), "{}\n");
  writeFileSync(join(root, ".gitignore"), ".bin\n.state\n");
  declare(SERVICES());
  git("add", "-A");
  git("commit", "-q", "-m", "c0");
  process.chdir(boxDir);
});

afterAll(async () => {
  process.chdir(saved.cwd);
  for (const [k, v] of [["PATH", saved.PATH], ["FAKE_SPRITE_STATE", saved.STATE], ["CHANT_CONVERGE_RESOURCE", saved.RESOURCE], ["BOX_HOME", saved.BOX_HOME]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  declare(SERVICES());
  rmSync(calls, { force: true });
});

describe("the sprite-env listing and create line (#2880)", () => {
  test("parses a sprite's JSON and the kit stand-in's table, with each definition", () => {
    expect(parseServiceDefinitions(JSON.stringify([{ name: "door", cmd: "/x/run-door.sh", args: [], needs: ["hud"], http_port: 8080, state: { status: "running" } }]))).toEqual([
      { name: "door", status: "running", cmd: "/x/run-door.sh", needs: ["hud"], httpPort: 8080 },
    ]);
    expect(parseServiceDefinitions(JSON.stringify([{ name: "a", cmd: "node", args: ["a.js"], needs: null, state: { status: "stopped" } }]))).toEqual([
      { name: "a", status: "stopped", cmd: "node a.js", needs: [] },
    ]);
    expect(parseServiceDefinitions("app\trunning\t-\t-\t/x/run-app.sh\ndoor\tstarting\thud\t8080\t/x/run-door.sh\nold\tstopped\n")).toEqual([
      { name: "app", status: "running", needs: [], httpPort: null, cmd: "/x/run-app.sh" },
      { name: "door", status: "starting", needs: ["hud"], httpPort: 8080, cmd: "/x/run-door.sh" },
      { name: "old", status: "stopped" },
    ]);
  });

  test("a difference in cmd, needs or httpPort is named, a field the listing lacks is not compared", () => {
    const declared = { name: "door", cmd: "${H}/d.sh", needs: ["hud"], httpPort: 8080, duration: null, health: null, optional: false };
    expect(listedServiceDiffers({ name: "door", status: "running", cmd: "/h/d.sh", needs: ["hud"], httpPort: 8080 }, declared, "/h/d.sh")).toBeNull();
    expect(listedServiceDiffers({ name: "door", status: "running", cmd: "/h/old.sh", needs: ["hud"], httpPort: 8080 }, declared, "/h/d.sh")).toMatch(/^cmd/);
    expect(listedServiceDiffers({ name: "door", status: "running", cmd: "/h/d.sh", needs: [], httpPort: 8080 }, declared, "/h/d.sh")).toMatch(/^needs/);
    expect(listedServiceDiffers({ name: "door", status: "running", cmd: "/h/d.sh", needs: ["hud"], httpPort: null }, declared, "/h/d.sh")).toMatch(/^httpPort/);
    expect(listedServiceDiffers({ name: "door", status: "running" }, declared, "/h/d.sh")).toBeNull();
    expect(spriteEnvCreateArgs({ ...declared, duration: "2s" }, "/h/d.sh")).toEqual(["services", "create", "door", "--cmd", "/h/d.sh", "--needs", "hud", "--http-port", "8080", "--duration", "2s"]);
    expect(spriteEnvCreateArgs(declared, ["node", "/h/preview.mjs", "--port", "5173"])).toEqual(["services", "create", "door", "--cmd", "node", "--args", "/h/preview.mjs,--port,5173", "--needs", "hud", "--http-port", "8080", "--no-stream"]);
  });

  test("${VAR} expands from the environment, and an unset one fails naming it", () => {
    expect(expandServiceCommand("app", "${HOME}/box/run.sh --port ${PORT}", { HOME: "/home/sprite", PORT: "5173" })).toBe("/home/sprite/box/run.sh --port 5173");
    expect(() => expandServiceCommand("app", "${NOPE}/run.sh", {})).toThrow("service app's cmd names ${NOPE}, which is not set in this process's environment");
  });

  test("a cmd with arguments splits on whitespace into the executable and its arguments, expanding each word (sandpit#6)", () => {
    expect(serviceCommandArgv("app", "node ${HOME}/box/app/steward/preview.mjs", { HOME: "/home/sprite" })).toEqual(["node", "/home/sprite/box/app/steward/preview.mjs"]);
    expect(serviceCommandArgv("app", "  npm   --prefix app start ", {})).toEqual(["npm", "--prefix", "app", "start"]);
    expect(serviceCommandArgv("app", "${BIN} --root ${ROOT}", { BIN: "/opt/x", ROOT: "/a b" })).toEqual(["/opt/x", "--root", "/a b"]);
    expect(() => serviceCommandArgv("app", "node a.js --hosts a,b", {})).toThrow('service app\'s cmd has the argument "a,b"');
    expect(() => serviceCommandArgv("app", "   ", {})).toThrow("service app's cmd is empty");
  });
});

describe("spriteApplyServices({ box: true }) through sprite-env (#2880)", () => {
  test("creates the declared services in dependency order, a second run changes nothing, and a changed cmd replaces that one service", async () => {
    // Declared hud first, so the order is the needs', not the file's.
    declare([SERVICES()[1], SERVICES()[0], SERVICES()[2]]);
    const first = await spriteApplyServices({ box: true, start: true });
    expect(first.services).toEqual([{ name: "app", action: "created" }, { name: "hud", action: "created" }]);
    expect(first).toMatchObject({ applied: ["app", "hud"], started: [] });
    expect(takeCalls()).toEqual([
      "services create app --cmd /home/sprite/box/run-app.sh --duration 3s",
      "services create hud --cmd /home/sprite/box/run-daemon.sh --needs app --http-port 8080 --duration 3s",
    ]);

    const second = await spriteApplyServices({ box: true, start: true });
    expect(second.services).toEqual([{ name: "app", action: "left" }, { name: "hud", action: "left" }]);
    expect(second.applied).toEqual([]);
    expect(takeCalls()).toEqual([]);

    declare([SERVICES()[0], { ...SERVICES()[1], cmd: "${BOX_HOME}/run-hud.sh" }, SERVICES()[2]]);
    const third = await spriteApplyServices({ box: true, start: true });
    expect(third.services).toEqual([{ name: "app", action: "left" }, { name: "hud", action: "replaced" }]);
    expect(takeCalls()).toEqual(["services delete hud", "services create hud --cmd /home/sprite/box/run-hud.sh --needs app --http-port 8080 --duration 3s"]);
    expect((listed().get("hud") as { cmd: string }).cmd).toBe("/home/sprite/box/run-hud.sh");
  });

  test("a cmd with arguments goes to sprite-env as --cmd and --args, and the listing it makes reads back as converged (sandpit#6)", async () => {
    declare([{ name: "app", cmd: "node ${BOX_HOME}/preview.mjs --port 5173", duration: "3s", health: health("app") }]);
    rmSync(join(state, "app.json"), { force: true });
    takeCalls();
    // hud, from the earlier tests, is not declared here, so the apply deletes it.
    expect((await spriteApplyServices({ box: true })).services).toEqual([{ name: "hud", action: "deleted" }, { name: "app", action: "created" }]);
    expect(takeCalls()).toEqual(["services delete hud", "services create app --cmd node --args /home/sprite/box/preview.mjs,--port,5173 --duration 3s"]);
    expect(listed().get("app")).toMatchObject({ cmd: "node", args: ["/home/sprite/box/preview.mjs", "--port", "5173"] });
    expect((await spriteApplyServices({ box: true })).services).toEqual([{ name: "app", action: "left" }]);
    expect(takeCalls()).toEqual([]);
    rmSync(join(state, "app.json"), { force: true });
    declare(SERVICES());
  });

  test("a moved httpPort is let go by its old holder before the new holder is defined with it", async () => {
    await spriteApplyServices({ box: true });
    takeCalls();
    // app comes first in start order, so without the release app would be
    // defined with the port while hud still holds it, and the supervisor refuses that.
    const { httpPort: _moved, ...hudWithoutPort } = SERVICES()[1];
    declare([{ ...SERVICES()[0], httpPort: 8080 }, hudWithoutPort, SERVICES()[2]]);
    const moved = await spriteApplyServices({ box: true });
    expect(moved.services).toEqual([{ name: "app", action: "replaced" }, { name: "hud", action: "replaced" }]);
    expect(takeCalls()).toEqual([
      "services delete hud",
      "services create hud --cmd /home/sprite/box/run-daemon.sh --needs app --duration 3s",
      "services delete app",
      "services create app --cmd /home/sprite/box/run-app.sh --http-port 8080 --duration 3s",
    ]);
    expect((listed().get("app") as { http_port: number }).http_port).toBe(8080);
    expect((listed().get("hud") as { http_port: number }).http_port).toBe(0);

    // And back again: app lets go first this time.
    declare(SERVICES());
    expect((await spriteApplyServices({ box: true })).services).toEqual([{ name: "app", action: "replaced" }, { name: "hud", action: "replaced" }]);
    expect(takeCalls()).toEqual([
      "services delete app",
      "services create app --cmd /home/sprite/box/run-app.sh --duration 3s",
      "services delete hud",
      "services create hud --cmd /home/sprite/box/run-daemon.sh --needs app --http-port 8080 --duration 3s",
    ]);
  });

  test("a full apply deletes the services the block does not declare, dependants first; only and prune: false leave them", async () => {
    await spriteApplyServices({ box: true });
    // Two services nobody declared, one needing the other, and an optional one that is declared.
    const extra = (name: string, needs: string[]) =>
      writeFileSync(join(state, `${name}.json`), JSON.stringify({ name, cmd: `/x/${name}.sh`, args: [], needs, httpPort: 0, status: "running" }));
    extra("old-db", []);
    extra("old-api", ["old-db"]);
    extra("site", []);
    takeCalls();

    expect((await spriteApplyServices({ box: true, only: ["app"] })).services).toEqual([{ name: "app", action: "left" }]);
    expect((await spriteApplyServices({ box: true, prune: false })).services).toEqual([{ name: "app", action: "left" }, { name: "hud", action: "left" }]);
    expect(takeCalls()).toEqual([]);

    const pruned = await spriteApplyServices({ box: true });
    expect(pruned.services).toEqual([
      { name: "old-api", action: "deleted" },
      { name: "old-db", action: "deleted" },
      { name: "app", action: "left" },
      { name: "hud", action: "left" },
    ]);
    expect(pruned.applied).toEqual([]);
    expect(takeCalls()).toEqual(["services delete old-api", "services delete old-db"]);
    expect([...listed().keys()].sort()).toEqual(["app", "hud", "site"]);
    rmSync(join(state, "site.json"));
  });

  test("start starts a defined service that is stopped; without start it is left", async () => {
    await spriteApplyServices({ box: true });
    setStatus("app", "stopped");
    takeCalls();
    expect((await spriteApplyServices({ box: true })).services).toEqual([{ name: "app", action: "left" }, { name: "hud", action: "left" }]);
    const started = await spriteApplyServices({ box: true, start: true });
    expect(started.services).toEqual([{ name: "app", action: "started" }, { name: "hud", action: "left" }]);
    expect(started.started).toEqual(["app"]);
    expect(takeCalls()).toEqual(["services start app"]);
  });

  test("an optional service is applied only when only names it, and restart restarts the named ones already converged", async () => {
    await spriteApplyServices({ box: true });
    expect(listed().has("site")).toBe(false);
    takeCalls();
    expect((await spriteApplyServices({ box: true, only: ["site"], start: true, restart: true })).services).toEqual([{ name: "site", action: "created" }]);
    expect((await spriteApplyServices({ box: true, only: ["site"], start: true, restart: true })).services).toEqual([{ name: "site", action: "restarted" }]);
    expect(takeCalls()).toEqual(["services create site --cmd /home/sprite/box/run-site.sh --no-stream", "services restart site"]);
    await expect(spriteApplyServices({ box: true, only: ["api"] })).rejects.toThrow("only names api, which the box block does not declare; declared: app, hud, site");
  });

  test("an unset variable fails before anything changes, and the forms it refuses", async () => {
    rmSync(join(state, "app.json"), { force: true });
    delete process.env.BOX_HOME;
    try {
      await expect(spriteApplyServices({ box: true })).rejects.toThrow("${BOX_HOME}, which is not set");
    } finally {
      process.env.BOX_HOME = "/home/sprite/box";
    }
    expect(takeCalls()).toEqual([]);
    await expect(spriteApplyServices({})).rejects.toThrow(/pass box: true/);
    await expect(spriteApplyServices({ id: "box-1", box: true })).rejects.toThrow(/drop the id/);
  });
});

describe("a ConvergeOp over the box block's services (#2880)", () => {
  test("observe with box: true records a stopped declared service drifted, and the restart Op with box: true restarts it and waits for its health", async () => {
    for (const f of ["app", "hud", "site"]) rmSync(join(state, `${f}.json`), { force: true });
    await spriteApplyServices({ box: true });
    const activities = await loadActivities(["fly"]);
    const run$ = new Map<string, ActivityFn>([...activities, ["convergeTick", convergeTick as unknown as ActivityFn]]);

    // The observer reads the block: site is optional and not defined, so it is skipped.
    expect(await spriteServicesObserve({ box: true, probes: 1 })).toEqual({
      resources: [
        { name: "app", status: "in-sync", detail: expect.stringContaining("answers 200") },
        { name: "hud", status: "in-sync", detail: expect.stringContaining("answers 200") },
      ],
      skipped: ["site"],
    });
    await expect(spriteServicesObserve({ box: true, services: [{ name: "app" }] })).rejects.toThrow(/takes no services or servicesFile beside it/);

    const { op } = ConvergeOp({
      name: "box-converge",
      env: "box",
      dial: "apply",
      observe: observeStep({ box: true, probes: 1 }),
      rules: [
        when<ResourceSymptom>(eq("status", "drifted"), run("restart-service"), { id: "restart-drifted", why: "A declared service that stopped is restarted." }),
      ],
    });
    const config = (op as unknown as { props: OpConfig }).props;
    setStatus("app", "stopped");
    const tick = await runOpLocally(config, run$, {}, undefined, { cwd: boxDir, ledger: { cwd: boxDir } });
    expect(tick.status).toBe("ok");
    const ticks = (await readConvergeLedger("box", { cwd: boxDir })).records;
    expect(ticks.at(-1)).toMatchObject({
      firedRuleIds: ["restart-drifted"],
      outcomes: [{ ruleId: "restart-drifted", action: "ran", op: "restart-service", resource: "app" }],
      resources: [{ name: "app", status: "drifted", detail: "stopped" }, { name: "hud", status: "in-sync" }],
    });

    // The Op the rule dispatches: spriteServiceRestart reads app's health URL from the block.
    setStatus("app", "stopped");
    takeCalls();
    const restart: OpConfig = { name: "restart-service", phases: [{ name: "Restart", steps: [restartStep({ box: true, waitMs: 2000 })] }] } as unknown as OpConfig;
    process.env.CHANT_CONVERGE_RESOURCE = "app";
    try {
      const ran = await runOpLocally(restart, run$, {}, undefined, { cwd: boxDir, ledger: { cwd: boxDir } });
      expect(ran.status).toBe("ok");
      await expect(spriteServiceRestart({ box: true, waitMs: 2000 })).resolves.toEqual({ name: "app", healthy: true });
    } finally {
      delete process.env.CHANT_CONVERGE_RESOURCE;
    }
    expect(takeCalls()).toEqual(["services restart app", "services restart app"]);
    expect((listed().get("app") as { state: { status: string } }).state.status).toBe("running");
  });
});
