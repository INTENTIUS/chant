/**
 * Box isolation (#2727): hosts in the declaration and a host, slot, ports,
 * state and cookies in a member's box block, the values derived from a box's
 * identity, `chant workspace check`'s WSP123 and WSP124, and the resolved
 * values in `chant workspace status --json`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import { boxCollisions, boxLiterals, resolveBoxes, stateRootLiteral, statePathLiteral } from "./box-isolation";
import { runDeclarationChecks, WORKSPACE_CHECKS } from "./checks";
import { DEFAULT_STATE_ROOT, parseDeclaration, WorkspaceReadError, type Declaration } from "./declaration";
import { formatStatus, workspaceStatus } from "./status";
import statusSchema from "./status.schema.json";

const FILE = "chant.workspace.json";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const local = { name: "local", ports: { from: 7100, to: 7999, perBox: 20 } };

/** A box member, with the ports, hud state and cookies chaff's spec/box.ts and kernel/door.mjs hard-code today. */
const chaffBox = (name: string, slot: number, extra: Record<string, unknown> = {}) => ({
  name,
  dir: `boxes/${name}`,
  kind: "other",
  because: "a planted box",
  box: {
    host: "local",
    slot,
    ports: { app: 0, door: 1, proxy: 2, inject: 3, ticker: 4, behold: 5, surface: 6, historian: 7 },
    state: { HUD_IDENTITY_PATH: "hud/identity.json", HUD_DB_PATH: "hud/events.db", CHAFF_HUD_IDENTITY: "hud/identity.json" },
    cookies: ["hud_session", "chaff_door"],
    ...extra,
  },
});
type BoxMember = ReturnType<typeof chaffBox>;

const declaration = (members: BoxMember[], hosts: unknown[] = [local]) => ({ name: "lobby", schema: 1, members, hosts });

/** A committed git repository holding the declaration, and a file in each member's directory. */
function repo(value: ReturnType<typeof declaration>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-box-isolation-")));
  scratch.push(root);
  const files: Record<string, string> = { [FILE]: JSON.stringify(value, null, 2) };
  for (const m of value.members) files[`${m.dir}/README.md`] = `# ${m.name}\n`;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return root;
}

/** The box findings, less WSP009, which every member of kind other gets. */
async function findings(root: string) {
  const report = await runDeclarationChecks(root);
  return { ...report, diagnostics: report.diagnostics.filter((d) => d.ruleId !== "WSP009") };
}

function parse(value: unknown, reader = "0.91.0"): Declaration {
  return parseDeclaration(JSON.stringify(value, null, 2), FILE, reader);
}

function refusal(value: unknown): WorkspaceReadError {
  try {
    parse(value);
  } catch (err) {
    if (err instanceof WorkspaceReadError) return err;
    throw err;
  }
  throw new Error("expected the declaration to be refused");
}

describe("hosts, and a box's isolation in its block (#2727)", () => {
  test("are read, with the host's state root null when it is the default and no isolation without a host", () => {
    const d = parse({ ...declaration([chaffBox("fern", 0)]), members: [chaffBox("fern", 0), { name: "plain", dir: "plain", kind: "other", because: "x", box: { capabilities: [] } }] });
    expect(d.hosts).toEqual([{ name: "local", ports: { from: 7100, to: 7999, perBox: 20 }, stateRoot: null, pointer: "/hosts/0" }]);
    expect(d.members[0].box?.isolation).toMatchObject({ host: "local", slot: 0, cookies: ["hud_session", "chaff_door"] });
    expect(d.members[1].box?.isolation).toBeNull();
    expect(parse({ name: "plain", schema: 1, members: [] }).hosts).toEqual([]);
  });

  test("a block with only a host, or only isolation, still reads: capabilities are optional", () => {
    const d = parse(declaration([{ ...chaffBox("fern", 0), box: { host: "local", slot: 0 } } as BoxMember]));
    expect(d.members[0].box).toMatchObject({ capabilities: [], isolation: { host: "local", slot: 0, ports: {}, state: {}, cookies: [] } });
  });

  test("the rules the schema can't say are read errors, each at its place", () => {
    const cases: [unknown, string, RegExp][] = [
      [declaration([chaffBox("fern", 0)], [local, local]), "name", /host name "local" is already used/],
      [declaration([chaffBox("fern", 0, { host: "cloud" })]), "host", /names the host "cloud", which hosts does not declare; declared hosts: local/],
      [declaration([chaffBox("fern", 45)]), "slot", /slot 45 on host local, which needs ports 8000 to 8019, past the end of the host's range \(7999\); the range holds 45 slots/],
      [declaration([chaffBox("fern", 0, { ports: { app: 20 } })]), "app", /gives port app offset 20, and host local gives each box 20 ports \(offsets 0 to 19\)/],
      [declaration([], [{ name: "local", ports: { from: 8000, to: 7000, perBox: 1 } }]), "ports", /starts at 8000, after its end 7000/],
    ];
    for (const [value, key, message] of cases) {
      const err = refusal(value);
      expect(err.code).toBe("declaration-invalid");
      expect(err.message).toMatch(message);
      expect(JSON.stringify(value, null, 2).split("\n")[err.location!.line - 1]).toContain(`"${key}"`);
    }
  });

  test("the schema refuses an unknown field, a bad cookie name, a host without a slot and ports without a host", () => {
    for (const bad of [
      declaration([chaffBox("fern", 0, { stateDir: "/tmp/x" })]),
      declaration([chaffBox("fern", 0, { cookies: ["hud session"] })]),
      declaration([{ ...chaffBox("fern", 0), box: { host: "local" } } as BoxMember]),
      declaration([{ ...chaffBox("fern", 0), box: { ports: { app: 0 } } } as BoxMember]),
      declaration([], [{ name: "local", ports: { from: 0, to: 10, perBox: 1 } }]),
    ]) {
      expect(refusal(bad).code).toBe("declaration-invalid");
    }
  });
});

describe("the values derived from a box's identity", () => {
  test("ports from the slot's block, state under <stateRoot>/<name>, cookies suffixed with the name", () => {
    const [fern, moss] = resolveBoxes(parse(declaration([chaffBox("fern", 0), chaffBox("moss", 1)]))).map((b) => b.isolation);
    expect(fern).toEqual({
      host: "local",
      slot: 0,
      portRange: { from: 7100, to: 7119 },
      ports: { app: 7100, door: 7101, proxy: 7102, inject: 7103, ticker: 7104, behold: 7105, surface: 7106, historian: 7107 },
      stateDir: `${DEFAULT_STATE_ROOT}/fern`,
      state: {
        HUD_IDENTITY_PATH: "${XDG_STATE_HOME}/chant/boxes/fern/hud/identity.json",
        HUD_DB_PATH: "${XDG_STATE_HOME}/chant/boxes/fern/hud/events.db",
        CHAFF_HUD_IDENTITY: "${XDG_STATE_HOME}/chant/boxes/fern/hud/identity.json",
      },
      cookies: { hud_session: "hud_session_fern", chaff_door: "chaff_door_fern" },
    });
    expect(moss.portRange).toEqual({ from: 7120, to: 7139 });
    expect(moss.ports.door).toBe(7121);
    expect(moss.state.HUD_IDENTITY_PATH).toBe("${XDG_STATE_HOME}/chant/boxes/moss/hud/identity.json");
    expect(moss.cookies.hud_session).toBe("hud_session_moss");
  });

  test("are the same for the same identity, whatever other boxes are declared or in what order", () => {
    const alone = resolveBoxes(parse(declaration([chaffBox("moss", 3)])))[0].isolation;
    const among = resolveBoxes(parse(declaration([chaffBox("zinnia", 7), chaffBox("moss", 3), chaffBox("fern", 0)])))[1].isolation;
    expect(among).toEqual(alone);
  });

  test("a host's own state root is used, trailing slash or not", () => {
    const [b] = resolveBoxes(parse(declaration([chaffBox("fern", 0)], [{ ...local, stateRoot: "${BOX_STATE}/" }])));
    expect(b.isolation.stateDir).toBe("${BOX_STATE}/fern");
    expect(b.isolation.state.HUD_DB_PATH).toBe("${BOX_STATE}/fern/hud/events.db");
  });
});

describe("literal machine paths", () => {
  test("a state root starts with an environment reference other than $HOME", () => {
    expect(stateRootLiteral("${XDG_STATE_HOME}/chant/boxes")).toBeUndefined();
    expect(stateRootLiteral("$XDG_STATE_HOME")).toBeUndefined();
    expect(stateRootLiteral("${HOME}/alecraso/hud-live")).toMatch(/\$HOME/);
    expect(stateRootLiteral("$HOME/.local/state")).toMatch(/\$HOME/);
    expect(stateRootLiteral("/Users/alex/state")).toMatch(/environment reference/);
    expect(stateRootLiteral("~/state")).toMatch(/environment reference/);
    expect(stateRootLiteral("${XDG_STATE_HOME}/../x")).toMatch(/\.\./);
  });

  test("a state entry is relative to the box's state directory and stays in it", () => {
    expect(statePathLiteral("hud/identity.json")).toBeUndefined();
    expect(statePathLiteral("/Users/alex/.local/state/hud/identity.json")).toMatch(/absolute/);
    expect(statePathLiteral("${HOME}/.local/state/hud/box-chaff/identity.json")).toMatch(/environment reference/);
    expect(statePathLiteral("~/hud")).toMatch(/home/);
    expect(statePathLiteral("../moss/hud/identity.json")).toMatch(/\.\./);
    expect(statePathLiteral("C:\\state")).toMatch(/Windows/);
  });
});

describe("chant workspace check: WSP123 and WSP124", () => {
  test("are fixed errors in the catalog, with the names the issue gives them", () => {
    const byId = Object.fromEntries(WORKSPACE_CHECKS.map((c) => [c.id, c]));
    expect([byId.WSP123.name, byId.WSP123.severity, byId.WSP123.configurable]).toEqual(["box-isolation-collision", "error", false]);
    expect([byId.WSP124.name, byId.WSP124.severity, byId.WSP124.configurable]).toEqual(["box-isolation-literal", "error", false]);
  });

  test("two boxes with distinct names and slots pass, and status --json shows their distinct values", async () => {
    const root = repo(declaration([chaffBox("fern", 0), chaffBox("moss", 1)]));
    const report = await findings(root);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);

    const doc = await workspaceStatus({ cwd: root, env: "local" });
    if ("error" in doc) throw new Error(doc.error.message);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(statusSchema);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    const [fern, moss] = doc.members.map((m) => m.box!.isolation!);
    for (const what of ["ports", "state", "cookies"] as const) {
      const a = new Set<unknown>(Object.values(fern[what]));
      expect(Object.values(moss[what]).some((v) => a.has(v)), what).toBe(false);
    }
    expect(doc.members[0].box).toMatchObject({ capabilities: [], isolation: { ports: { door: 7101 } } });
    expect(formatStatus(doc)).toContain("fern  local  0     7100-7119  ${XDG_STATE_HOME}/chant/boxes/fern");
  });

  test("two boxes on one host with the same port range and state root collide", async () => {
    const report = await findings(repo(declaration([chaffBox("fern", 2), chaffBox("moss", 2)])));
    expect(report.ok).toBe(false);
    const found = report.diagnostics.filter((d) => d.ruleId === "WSP123");
    // One finding per shared port; state and cookies stay apart, since the names differ.
    expect(found).toHaveLength(8);
    expect(found[0]).toMatchObject({ severity: "error", entity: "moss", code: "box-isolation-collision" });
    expect(found[0].message).toBe(
      "box-isolation-collision: fern.app and moss.app on host local resolve to the same port 7140; give each box on a host its own slot",
    );
  });

  test("the same slot on two hosts is no collision: hosts share nothing", () => {
    const hosts = [local, { ...local, name: "tailnet" }];
    expect(boxCollisions(parse(declaration([chaffBox("fern", 0), chaffBox("moss", 0, { host: "tailnet" })], hosts)))).toEqual([]);
  });

  test("two ports in one box at one offset collide; two state entries naming one file do not", () => {
    const d = parse(declaration([chaffBox("fern", 0, { ports: { app: 0, door: 0 } })]));
    expect(boxCollisions(d).map((c) => [c.what, c.value, c.holders.map((h) => `${h.box}.${h.name}`)])).toEqual([["port", "7100", ["fern.app", "fern.door"]]]);
  });

  test("a state entry spelled into another box's directory collides with it, and is a literal", () => {
    const d = parse(declaration([chaffBox("fern", 0), chaffBox("moss", 1, { state: { HUD_IDENTITY_PATH: "./../fern/hud/identity.json" } })]));
    expect(boxLiterals(d).map((l) => l.pointer)).toEqual(["/members/1/box/state/HUD_IDENTITY_PATH"]);
    const state = boxCollisions(d).filter((c) => c.what === "state");
    expect(state.map((c) => [c.value, c.holders.map((h) => `${h.box}.${h.name}`)])).toEqual([
      ["${XDG_STATE_HOME}/chant/boxes/fern/hud/identity.json", ["fern.HUD_IDENTITY_PATH", "moss.HUD_IDENTITY_PATH"]],
    ]);
  });

  test("a hard-coded machine path in a host or a box is WSP124", async () => {
    const hosts = [{ ...local, stateRoot: "${HOME}/alecraso/hud-live" }];
    const report = await findings(repo(declaration([chaffBox("chaff", 0, { state: { HUD_IDENTITY_PATH: "${HOME}/.local/state/hud/box-chaff/identity.json" } })], hosts)));
    expect(report.diagnostics.map((d) => [d.ruleId, d.entity ?? null, d.code])).toEqual([
      ["WSP124", "chaff", "box-isolation-literal"],
      ["WSP124", null, "box-isolation-literal"],
    ]);
    expect(report.diagnostics[1].message).toMatch(/^box-isolation-literal: host local's stateRoot "\$\{HOME\}\/alecraso\/hud-live" starts at \$HOME/);
    expect(report.diagnostics[0].message).toMatch(
      /^box-isolation-literal: member chaff's box gives state HUD_IDENTITY_PATH the path "\$\{HOME\}\/.local\/state\/hud\/box-chaff\/identity.json", which starts with an environment reference/,
    );
  });

  test("a fixed box check can't be turned off", async () => {
    const root = repo({ ...declaration([chaffBox("fern", 0), chaffBox("moss", 0)]), checks: { WSP123: "off" } } as ReturnType<typeof declaration>);
    const ids = (await findings(root)).diagnostics.map((d) => d.ruleId);
    expect(ids).toContain("WSP011");
    expect(ids).toContain("WSP123");
  });
});
