/**
 * #3595: the x- keys a declaration holds come back from `status --json` and
 * `ls --json` on the object that holds them, so a reader never parses the
 * declaration to get back what it wrote through chant.
 */

import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, repo } from "./__fixtures__/contract-repo";
import { extensionsAt, parseDeclaration } from "./declaration";
import { listWorkspace } from "./ls";
import lsSchema from "./ls.schema.json";
import { workspaceStatus } from "./status";
import statusSchema from "./status.schema.json";

afterAll(cleanScratch);

const APP = { owner: "alex", createdAt: "2026-10-01T00:00:00.000Z", repo: "acme/fern", branch: "main" };

const DECLARATION = {
  name: "fern",
  schema: 1,
  "x-lobby": { slot: 3 },
  members: [
    { name: "app", dir: "app", kind: "other", because: "the app", "x-member": 1 },
    {
      name: "steward",
      dir: "steward",
      kind: "other",
      because: "the box",
      box: {
        "x-factory": { intent: "box-001" },
        capabilities: [{ name: "inference", scope: ["chat"], "x-cap": true }],
        services: [{ name: "app", cmd: "node app.mjs", "x-svc": "a" }],
        factory: { builds: ["app"], check: { run: "npm test", "x-check": 2 }, publish: { repo: "acme/fern", "x-pub": "p" }, "x-fac": "f" },
        listing: { title: "Fern", line: "A review queue", "x-studio-app": APP },
        ship: { op: "ship", "x-ship": "s" },
      },
    },
  ],
};

describe("x- keys in the read contract (#3595)", () => {
  const root = repo({ "chant.workspace.json": `${JSON.stringify(DECLARATION, null, 2)}\n`, "app/a.txt": "", "steward/s.txt": "" }, true);

  test("extensionsAt reads the x- keys at a pointer, and nothing where there is no object", () => {
    const decl = parseDeclaration(JSON.stringify(DECLARATION), "chant.workspace.json");
    expect(extensionsAt(decl, "")).toEqual({ "x-lobby": { slot: 3 } });
    expect(extensionsAt(decl, "/members/0")).toEqual({ "x-member": 1 });
    expect(extensionsAt(decl, "/members/1/box/listing")).toEqual({ "x-studio-app": APP });
    expect(extensionsAt(decl, "/members/0/box")).toEqual({});
    expect(extensionsAt(decl, "/members/0/name")).toEqual({});
    expect(extensionsAt({ ...decl }, "")).toEqual({});
  });

  test("status --json keeps them on the member, the box and the box's parts", async () => {
    const out = await workspaceStatus({ cwd: root, env: "box" });
    contract(statusSchema).expectValid(out);
    if ("error" in out) throw new Error(out.error.message);
    const [app, steward] = out.members;
    expect(app).toMatchObject({ name: "app", "x-member": 1 });
    const box = steward.box!;
    expect(box).toMatchObject({ "x-factory": { intent: "box-001" } });
    expect(box.capabilities[0]).toMatchObject({ name: "inference", "x-cap": true });
    expect(box.services[0]).toMatchObject({ name: "app", "x-svc": "a" });
    expect(box.factory).toMatchObject({ "x-fac": "f", check: { run: "npm test", "x-check": 2 }, publish: { repo: "acme/fern", "x-pub": "p" } });
    expect(box.listing).toMatchObject({ title: "Fern", "x-studio-app": APP });
    expect(box.ship).toMatchObject({ op: "ship", "x-ship": "s" });
    expect(Object.keys(steward).filter((k) => k.startsWith("x-"))).toEqual([]);
  });

  test("ls --json keeps them on each member and on the workspace", () => {
    const out = listWorkspace({ cwd: root });
    contract(lsSchema).expectValid(out);
    if ("error" in out) throw new Error(out.error.message);
    expect(out.workspace).toMatchObject({ name: "fern", "x-lobby": { slot: 3 } });
    expect(out.members[0]).toMatchObject({ name: "app", "x-member": 1 });
    expect(Object.keys(out.members[1]).filter((k) => k.startsWith("x-"))).toEqual([]);
  });
});
