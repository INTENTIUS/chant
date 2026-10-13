/**
 * #2880: a box block declares its services. The declaration reads them, a
 * `needs` naming no service of the block or forming a cycle, a name given
 * twice and a second httpPort each fail the read (declaration-invalid), so
 * `chant workspace check` fails with WSP001, and `readBoxServices` gives the
 * list of the member a process runs in.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "./checks";
import { parseDeclaration, WorkspaceReadError } from "./declaration";
import { readBoxServices } from "./box-services";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-box-services-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const declaration = (services: unknown[]) =>
  JSON.stringify(
    {
      name: "acme",
      schema: 1,
      members: [
        { name: "app", dir: "app", kind: "other", because: "the app" },
        { name: "box", dir: "box", kind: "other", because: "the box's steward and its Ops", box: { services } },
      ],
    },
    null,
    2,
  );

const parse = (services: unknown[]) => parseDeclaration(declaration(services), "chant.workspace.json");

/** The error a declaration's read fails with, as its code and message. */
function readFailure(services: unknown[]): { code: string; message: string; line: number | undefined } {
  try {
    parse(services);
  } catch (err) {
    if (err instanceof WorkspaceReadError) return { code: err.code, message: err.message, line: err.location?.line };
    throw err;
  }
  throw new Error("the declaration read");
}

const TWO = [
  { name: "app", cmd: "${HOME}/box/run-app.sh", duration: "3s", health: "http://127.0.0.1:5173/health" },
  { name: "hud", cmd: "${HOME}/box/run-daemon.sh", needs: ["app"], httpPort: 8080 },
];

describe("the services of a box block (#2880)", () => {
  test("two services, one needing the other, read with every field", () => {
    expect(parse(TWO).members[1].box?.services).toEqual([
      { name: "app", cmd: "${HOME}/box/run-app.sh", needs: [], httpPort: null, duration: "3s", health: "http://127.0.0.1:5173/health", optional: false, pointer: "/members/1/box/services/0" },
      { name: "hud", cmd: "${HOME}/box/run-daemon.sh", needs: ["app"], httpPort: 8080, duration: null, health: null, optional: false, pointer: "/members/1/box/services/1" },
    ]);
    expect(parseDeclaration(JSON.stringify({ name: "a", schema: 1, members: [{ name: "b", dir: "b", kind: "other", because: "x", box: {} }] }), "chant.workspace.json").members[0].box?.services).toEqual([]);
  });

  test("a needs naming no service of the block is declaration-invalid, at the entry", () => {
    const f = readFailure([TWO[0], { ...TWO[1], needs: ["api"] }]);
    expect(f.code).toBe("declaration-invalid");
    expect(f.message).toBe(`member box's box service hud needs "api", which the block does not declare; declared services: app, hud`);
  });

  test("needs that form a cycle are declaration-invalid, and so is a service that needs itself", () => {
    const cycle = readFailure([
      { name: "a", cmd: "a", needs: ["c"] },
      { name: "b", cmd: "b", needs: ["a"] },
      { name: "c", cmd: "c", needs: ["b"] },
    ]);
    expect(cycle).toMatchObject({ code: "declaration-invalid", message: "member box's box services need each other in a cycle: a -> c -> b -> a" });
    expect(readFailure([{ name: "a", cmd: "a", needs: ["a"] }]).message).toMatch(/cycle: a -> a$/);
  });

  test("a name given twice, and a second httpPort, are declaration-invalid", () => {
    expect(readFailure([TWO[0], { ...TWO[0], cmd: "other" }])).toMatchObject({ code: "declaration-invalid", message: expect.stringMatching(/declares the service app twice; the first is at \/members\/1\/box\/services\/0/) });
    expect(readFailure([{ ...TWO[0], httpPort: 5173 }, TWO[1]]).message).toMatch(/gives both app \(port 5173\) and hud \(port 8080\) an httpPort/);
  });

  test("the schema refuses a service with no cmd, an unknown field, a malformed duration or a health that is no URL", () => {
    expect(readFailure([{ name: "app" }]).code).toBe("declaration-invalid");
    expect(readFailure([{ ...TWO[0], restart: "always" }]).message).toMatch(/unknown field "restart"/);
    expect(readFailure([{ ...TWO[0], duration: "3 seconds" }]).code).toBe("declaration-invalid");
    expect(readFailure([{ ...TWO[0], health: "/health" }]).code).toBe("declaration-invalid");
  });

  test("chant workspace check passes the valid block and fails the invalid one with WSP001 declaration-invalid", async () => {
    const good = repo({ "chant.workspace.json": declaration(TWO), "app/.keep": "", "box/.keep": "" });
    expect((await runDeclarationChecks(good)).diagnostics.filter((d) => d.ruleId === "WSP001")).toEqual([]);
    const bad = repo({ "chant.workspace.json": declaration([TWO[0], { ...TWO[1], needs: ["api"] }]), "app/.keep": "", "box/.keep": "" });
    const found = (await runDeclarationChecks(bad)).diagnostics;
    expect(found.map((d) => [d.ruleId, d.severity, d.code])).toEqual([["WSP001", "error", "declaration-invalid"]]);
    expect(found[0].message).toMatch(/needs "api", which the block does not declare/);
  });
});

describe("readBoxServices (#2880)", () => {
  test("reads the services of the member whose directory holds the working directory", () => {
    const root = repo({ "chant.workspace.json": declaration(TWO), "app/.keep": "", "box/ops/.keep": "" });
    const read = readBoxServices(join(root, "box", "ops"));
    expect(read.member).toBe("box");
    expect(read.root).toBe(root);
    expect(read.services.map((s) => [s.name, s.needs])).toEqual([["app", []], ["hud", ["app"]]]);
  });

  test("a member with no box block, a directory no member holds, and no workspace are errors", () => {
    const root = repo({ "chant.workspace.json": declaration(TWO), "app/.keep": "", "box/.keep": "", "elsewhere/.keep": "" });
    expect(() => readBoxServices(join(root, "app"))).toThrow(/member app \(app\) has no box block/);
    expect(() => readBoxServices(join(root, "elsewhere"))).toThrow(/no member of the workspace/);
    const none = repo({ "x/.keep": "" });
    expect(() => readBoxServices(join(none, "x"))).toThrow(/no chant.workspace.json/);
  });
});
