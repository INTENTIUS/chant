/**
 * #2778 — a box's services as resources a ConvergeOp observes and converges.
 *
 * `sprite-env` here is a stand-in with the command line a sprite's has (and
 * the studio kit's has): `services list` prints `name<TAB>state`, and
 * `restart`/`stop`/`start` flip the state kept in a directory. A small HTTP
 * server answers each service's health URL with 200 while it runs. `chant`
 * on PATH stands in for `chant run <op>`: it runs what the dispatched
 * `restart-service` Op would, `sprite-env services restart
 * "$CHANT_CONVERGE_RESOURCE"`, and records the call.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ConvergeOp, declareSteward, eq, loadActivities, run, runOpLocally, when, type ActivityFn, type OpConfig, type ResourceSymptom } from "@intentius/chant/op";
import { convergeTick } from "@intentius/chant/op/activities";
import { readConvergeLedger } from "@intentius/chant/lifecycle/converge-ledger";
import { readMemberStewards } from "@intentius/chant/workspace/status-stewards";
import { createSpritesFake } from "./sprites-fake";
import { spriteCreate } from "./sprites";
import { spriteServiceCreate, spriteServiceStop } from "./sprite-services";
import { parseServicesList, spriteServiceRestart, spriteServicesObserve } from "./sprite-service-converge";
import { spriteServicesObserve as observeStep } from "../builders";

let dir: string;
let bin: string;
let state: string;
let server: Server;
let port = 0;
const saved = { PATH: process.env.PATH, cwd: process.cwd(), STATE: process.env.FAKE_SPRITE_STATE, RESOURCE: process.env.CHANT_CONVERGE_RESOURCE };

const SPRITE_ENV = `#!/usr/bin/env node
const { readdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.FAKE_SPRITE_STATE;
const [group, verb, name] = process.argv.slice(2);
if (group !== "services") process.exit(2);
const file = (n) => join(dir, n);
if (verb === "list") {
  for (const n of readdirSync(dir).sort()) console.log(n + "\\t" + readFileSync(file(n), "utf8").trim() + "\\t-\\t-\\tcmd");
} else if (["restart", "start", "stop"].includes(verb)) {
  if (!existsSync(file(name))) { console.error("sprite-env: no service " + name); process.exit(1); }
  writeFileSync(file(name), verb === "stop" ? "stopped" : "running");
} else process.exit(2);
`;

const CHANT = `#!/bin/sh
# chant run <op> --json, as far as a converge dispatch goes.
echo "$2 $CHANT_CONVERGE_RESOURCE" >> "$FAKE_SPRITE_STATE/../dispatched"
exec sprite-env services restart "$CHANT_CONVERGE_RESOURCE"
`;

function git(...args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const health = (name: string) => `http://127.0.0.1:${port}/${name}`;
const setState = (name: string, value: string) => writeFileSync(join(state, name), value);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "chant-sprite-converge-"));
  bin = join(dir, ".bin");
  state = join(dir, ".state", "services");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(bin, "sprite-env"), SPRITE_ENV);
  writeFileSync(join(bin, "chant"), CHANT);
  chmodSync(join(bin, "sprite-env"), 0o755);
  chmodSync(join(bin, "chant"), 0o755);
  server = createServer((req, res) => {
    const name = (req.url ?? "/").slice(1);
    const up = existsSync(join(state, name)) && readFileSync(join(state, name), "utf8").trim() === "running";
    res.writeHead(up ? 200 : 503).end(up ? "ok" : "down");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_SPRITE_STATE = state;
  git("init", "-q", "-b", "main");
  git("config", "user.email", "converge@example.com");
  git("config", "user.name", "Converge Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "chant.config.json"), "{}\n");
  writeFileSync(join(dir, ".gitignore"), ".bin\n.state\n");
  git("add", "-A");
  git("commit", "-q", "-m", "c0");
});

afterAll(async () => {
  process.chdir(saved.cwd);
  process.env.PATH = saved.PATH;
  if (saved.STATE === undefined) delete process.env.FAKE_SPRITE_STATE;
  else process.env.FAKE_SPRITE_STATE = saved.STATE;
  if (saved.RESOURCE === undefined) delete process.env.CHANT_CONVERGE_RESOURCE;
  else process.env.CHANT_CONVERGE_RESOURCE = saved.RESOURCE;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("parseServicesList", () => {
  test("reads a sprite-env's JSON and a stand-in's table", () => {
    expect(parseServicesList(JSON.stringify([{ name: "app", cmd: "x", state: { name: "app", status: "running" } }, { name: "hud", status: "stopped" }]))).toEqual(
      new Map([["app", "running"], ["hud", "stopped"]]),
    );
    expect(parseServicesList("app\trunning\t-\t-\tnode a\nsite\tstarting\t-\t-\tnode s\n")).toEqual(new Map([["app", "running"], ["site", "starting"]]));
    expect(parseServicesList("")).toEqual(new Map());
  });
});

describe("spriteServicesObserve through sprite-env (#2778)", () => {
  test("in sync, stopped, not answering, not defined, optional, and a supervisor that can't be read", async () => {
    setState("app", "running");
    setState("hud", "stopped");
    setState("door", "running");
    const services = [
      { name: "app", health: health("app") },
      { name: "hud", health: health("hud") },
      { name: "door", health: `http://127.0.0.1:${port}/nothing-here` },
      { name: "extra" },
      { name: "site", health: health("site"), optional: true },
    ];
    const seen = await spriteServicesObserve({ services, probes: 2, probeIntervalMs: 10 });
    expect(seen.skipped).toEqual(["site"]);
    expect(seen.resources.map((r) => [r.name, r.status])).toEqual([
      ["app", "in-sync"],
      ["hud", "drifted"],
      ["door", "drifted"],
      ["extra", "drifted"],
    ]);
    expect(seen.resources[2].detail).toMatch(/does not answer 200 after 2 tries/);
    expect(seen.resources[3].detail).toMatch(/no such service/);

    const unread = await spriteServicesObserve({ services: [{ name: "app" }], spriteEnv: join(dir, "missing-sprite-env") });
    expect(unread.resources).toEqual([{ name: "app", status: "unknown", detail: expect.stringMatching(/could not be read/) }]);

    // The declared list can live in a file the box already has.
    writeFileSync(join(dir, "services.json"), JSON.stringify({ services: [{ name: "app", health: health("app") }] }));
    const fromFile = await spriteServicesObserve({ servicesFile: join(dir, "services.json"), probes: 1 });
    expect(fromFile.resources).toEqual([{ name: "app", status: "in-sync", detail: expect.stringContaining("answers 200") }]);
  });

  test("spriteServiceRestart restarts the resource a converge rule dispatched it for, and waits for its health", async () => {
    setState("hud", "stopped");
    process.env.CHANT_CONVERGE_RESOURCE = "hud";
    try {
      await expect(spriteServiceRestart({ services: [{ name: "hud", health: health("hud") }], waitMs: 2000 })).resolves.toEqual({ name: "hud", healthy: true });
    } finally {
      delete process.env.CHANT_CONVERGE_RESOURCE;
    }
    expect(readFileSync(join(state, "hud"), "utf8")).toBe("running");
    await expect(spriteServiceRestart({})).rejects.toThrow(/CHANT_CONVERGE_RESOURCE/);
    await expect(spriteServiceRestart({ name: "nope" })).rejects.toThrow(/no service nope/);
  });
});

describe("spriteServicesObserve through the Sprites API (#2778)", () => {
  test("reads each service's state, and restarts one with stop and start", async () => {
    const fake = await createSpritesFake();
    try {
      await spriteCreate({ name: "box-1", endpoint: fake.url });
      await spriteServiceCreate({ id: "box-1", name: "app", cmd: "node app.js", endpoint: fake.url });
      await spriteServiceCreate({ id: "box-1", name: "hud", cmd: "node hud.js", endpoint: fake.url });
      await spriteServiceStop({ id: "box-1", name: "hud", endpoint: fake.url });
      const seen = await spriteServicesObserve({ id: "box-1", endpoint: fake.url, services: [{ name: "app" }, { name: "hud" }] });
      expect(seen.resources.map((r) => [r.name, r.status])).toEqual([["app", "in-sync"], ["hud", "drifted"]]);
      await spriteServiceRestart({ id: "box-1", endpoint: fake.url, name: "hud" });
      const after = await spriteServicesObserve({ id: "box-1", endpoint: fake.url, services: [{ name: "app" }, { name: "hud" }] });
      expect(after.resources.every((r) => r.status === "in-sync")).toBe(true);
    } finally {
      await fake.close();
    }
  });
});

describe("a ConvergeOp over a box's services (#2778)", () => {
  test("records the stopped service drifted, dispatches the restart its rule names, and records the next tick in sync", async () => {
    const activities = await loadActivities(["fly"]);
    expect(activities.has("spriteServicesObserve")).toBe(true);
    expect(activities.has("spriteServiceRestart")).toBe(true);
    const run$ = new Map<string, ActivityFn>([...activities, ["convergeTick", convergeTick as unknown as ActivityFn]]);

    setState("app", "running");
    setState("hud", "running");
    rmSync(join(state, "door"), { force: true });
    rmSync(join(state, "extra"), { force: true });
    const services = [
      { name: "app", health: health("app") },
      { name: "hud", health: health("hud") },
    ];
    const { op } = ConvergeOp({
      name: "box-converge",
      env: "box",
      dial: "apply",
      observe: observeStep({ services, probes: 1 }),
      rules: [
        when<ResourceSymptom>(eq("status", "drifted"), run("restart-service"), {
          id: "restart-drifted",
          why: "A declared service that stopped or stopped answering is restarted through its supervisor.",
        }),
        when<ResourceSymptom>(eq("status", "unknown"), { kind: "report", reason: "a service could not be observed" }, {
          id: "report-unknown",
          why: "unknown never remediates.",
        }),
      ],
    });
    const config = (op as unknown as { props: OpConfig }).props;

    // Stop one of the two.
    spawnSync("sprite-env", ["services", "stop", "app"], { env: process.env });
    const steward = declareSteward({ name: "box-steward", ops: [config] });
    mkdirSync(join(dir, "ops"), { recursive: true });
    writeFileSync(join(dir, "ops", "steward.op.ts"), `export const steward = ${JSON.stringify(steward)};\n`);
    const lastTick = async () => {
      const status = await readMemberStewards(dir, "local", new Date().toISOString());
      expect(status.reasons).toEqual([]);
      return status.stewards[0].ops[0];
    };

    process.chdir(dir);
    try {
      const first = await runOpLocally(config, run$, {}, undefined, { cwd: dir, ledger: { cwd: dir } });
      expect(first.status).toBe("ok");
      // workspace status shows the converge Op's last tick, with the rule that fired and for which service.
      const afterFirst = await lastTick();
      expect(afterFirst.lastRun).toMatchObject({ status: "ok" });
      expect(afterFirst.lastTick).toMatchObject({
        firedRuleIds: ["restart-drifted"],
        outcomes: [{ ruleId: "restart-drifted", action: "ran", op: "restart-service", resource: "app", reason: null }],
        resources: [{ name: "app", status: "drifted", detail: "stopped" }, { name: "hud", status: "in-sync" }],
      });
      const second = await runOpLocally(config, run$, {}, undefined, { cwd: dir, ledger: { cwd: dir } });
      expect(second.status).toBe("ok");
    } finally {
      process.chdir(saved.cwd);
    }

    expect(readFileSync(join(dir, ".state", "dispatched"), "utf8").trim().split("\n")).toEqual(["restart-service app"]);
    const ticks = (await readConvergeLedger("box", { cwd: dir })).records;
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({
      op: "box-converge",
      firedRuleIds: ["restart-drifted"],
      outcomes: [{ ruleId: "restart-drifted", action: "ran", op: "restart-service", resource: "app" }],
      resources: [
        { name: "app", status: "drifted" },
        { name: "hud", status: "in-sync" },
      ],
      summary: { drifted: 1, remediated: 1 },
    });
    expect(ticks[1]).toMatchObject({
      firedRuleIds: [],
      outcomes: [],
      resources: [
        { name: "app", status: "in-sync" },
        { name: "hud", status: "in-sync" },
      ],
      summary: { drifted: 0, remediated: 0 },
    });

    expect((await lastTick()).lastTick).toMatchObject({ firedRuleIds: [], outcomes: [], resources: [{ name: "app", status: "in-sync" }, { name: "hud", status: "in-sync" }] });
  });
});
