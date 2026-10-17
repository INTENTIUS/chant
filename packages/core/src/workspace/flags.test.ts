/**
 * Feature flags as workspace records (#4024): the flag kind's records on
 * read, the stale-flag check WSP118, the flags of a member by parameter, and
 * `status --json`'s `featureFlags`, on the fixture in
 * `__fixtures__/flag-workspace.ts`.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract } from "./__fixtures__/contract-repo";
import { flagWorkspace, flagRecord } from "./__fixtures__/flag-workspace";
import { runDeclarationChecks } from "./checks";
import { memberFlagBindings, readWorkspaceFlags } from "./flags-read";
import { loadRecordKind } from "./records";
import { queryRecords } from "./records-cli";
import recordsSchema from "./records.schema.json";
import { workspaceStatus } from "./status";
import statusSchema from "./status.schema.json";

let root: string;
beforeAll(() => {
  root = flagWorkspace();
});
afterAll(cleanScratch);

const KIND = "flags/flag.kind.mjs";

describe("the flag kind (#4024)", () => {
  test("the canonical kind chant ships loads, with its flag block and schema", async () => {
    const loaded = await loadRecordKind(join(import.meta.dirname, "reference-kinds", "flag", "flag.kind.mjs"));
    expect(loaded.kind.name).toBe("flag");
    expect(loaded.kind.flag).toEqual({ member: "member", param: "param", owner: "owner", values: "values", work: { field: "work", kind: "../work/work.kind.mjs" } });
    expect(loaded.schema.$id).toBe("urn:intentius:chant:flag:1");
  });

  test("a kind with a flag block and no idField is refused", async () => {
    const dir = flagWorkspace({
      [KIND]: `export const recordKind = { name: "flag", location: { dir: ".", match: "^x$" }, format: "json", schema: { id: "urn:intentius:chant:flag:1", path: "flag.schema.json" }, idFrom: "sha256", flag: { member: "m", param: "p", owner: "o", values: "v", work: { field: "w", kind: "../work/work.kind.mjs" } } };\n`,
    });
    await expect(loadRecordKind(join(dir, KIND))).rejects.toThrow(/a flag kind names its id with idField/);
  });

  test("records gives each flag its work item, the decisions it implements, and whether it is stale", async () => {
    const doc = await queryRecords({ kind: join(root, KIND), cwd: root, workGaps: false });
    contract(recordsSchema).expectValid(doc);
    if ("error" in doc || !("records" in doc)) throw new Error(JSON.stringify(doc));
    const byId = new Map(doc.records.map((r) => [r.id, r]));
    expect(byId.get("old-banner")).toMatchObject({
      valid: true,
      flag: { work: { id: "W-001", state: "done" }, implements: [{ id: "d-001", state: "confirmed", confirmed: true }], stale: true },
    });
    expect(byId.get("old-banner")!.warnings.map((w) => w.code)).toEqual(["flag-stale"]);
    expect(byId.get("new-checkout")).toMatchObject({
      valid: true,
      flag: { work: { id: "W-002", state: "in-progress" }, implements: [{ id: "d-002", state: "decided", confirmed: false }], stale: false },
    });
    expect(byId.get("new-checkout")!.warnings).toEqual([]);
  });

  test("a flag that names no known work item is warned flag-work-unknown and is never stale", async () => {
    const dir = flagWorkspace({ "flags/ghost.flag.md": flagRecord("ghost", { work: "W-404", member: "shop", param: "ghost", values: {} }) });
    const doc = await queryRecords({ kind: join(dir, KIND), cwd: dir, workGaps: false });
    if ("error" in doc || !("records" in doc)) throw new Error(JSON.stringify(doc));
    const ghost = doc.records.find((r) => r.id === "ghost")!;
    expect(ghost.flag).toEqual({ work: { id: "W-404", state: null }, implements: [], stale: false });
    expect(ghost.warnings.map((w) => w.code)).toEqual(["flag-work-unknown"]);
  });

  test("a superseded decision is not confirmed, so its flag is not stale", async () => {
    const dir = flagWorkspace({
      "decisions/d-001-the-banner.md": `---\nid: "d-001"\nstate: "confirmed"\nsupersedes: []\n---\n`,
      "decisions/d-003-a-new-banner.md": `---\nid: "d-003"\nstate: "confirmed"\nsupersedes: ["d-001"]\n---\n`,
    });
    const { flags } = await readWorkspaceFlags(dir);
    expect(flags.find((f) => f.id === "old-banner")).toMatchObject({ implements: [{ id: "d-001", confirmed: false }], stale: false });
  });
});

describe("WSP118, the stale-flag check (#4024)", () => {
  test("reports the flag whose work item's decisions are all confirmed, on its record, as a warning", async () => {
    const result = await runDeclarationChecks(root);
    const found = result.diagnostics.filter((d) => d.ruleId === "WSP118");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", code: "flag-stale", file: "flags/old-banner.flag.md" });
    expect(found[0].message).toMatch(/^flag old-banner is due for removal: its work item W-001 implements d-001 \(confirmed\)/);
  });

  test("reports nothing once the stale flag is removed", async () => {
    const dir = flagWorkspace({ "flags/old-banner.flag.md": null });
    const result = await runDeclarationChecks(dir);
    expect(result.diagnostics.filter((d) => d.ruleId === "WSP118")).toEqual([]);
  });
});

describe("a member's flags by parameter", () => {
  test("names the flag and its value in the environment, and none where the record gives none", async () => {
    expect(await memberFlagBindings(root, join(root, "shop"), "prod")).toEqual({
      member: "shop",
      byParam: { newCheckout: { flag: "new-checkout", value: false } },
      errors: [],
    });
    expect((await memberFlagBindings(root, join(root, "shop"), "staging"))!.byParam).toEqual({ newCheckout: { flag: "new-checkout", value: undefined } });
  });

  test("is null for a directory no member holds", async () => {
    expect(await memberFlagBindings(root, join(root, "flags"), "prod")).toBeNull();
  });

  test("two flags for one parameter, and an invalid flag record naming the member, are errors", async () => {
    const dir = flagWorkspace({
      "flags/twin.flag.md": flagRecord("twin", { work: "W-002", member: "shop", param: "newCheckout", values: { prod: true } }),
      "flags/broken.flag.md": `---\nschema: 1\nid: "broken"\nmember: "shop"\n---\n`,
    });
    const bindings = await memberFlagBindings(dir, join(dir, "shop"), "prod");
    expect(bindings!.errors.join("\n")).toMatch(/flags new-checkout and twin both set build parameter "newCheckout" of member shop/);
    expect(bindings!.errors.join("\n")).toMatch(/flag record flags\/broken\.flag\.md is not valid/);
  });
});

describe("status --json lists featureFlags per member (#4024)", () => {
  test("each flag with its values per environment, its work item and whether it is stale", async () => {
    const doc = await workspaceStatus({ cwd: root, env: "prod", readLedger: async () => ({ records: [], malformed: 0 }), readPromotionOrder: async () => [] });
    contract(statusSchema).expectValid(doc);
    if ("error" in doc) throw new Error(JSON.stringify(doc));
    const shop = doc.members.find((m) => m.name === "shop")!;
    expect(shop.featureFlags).toEqual([
      {
        id: "new-checkout",
        param: "newCheckout",
        owner: "alice",
        values: { dev: true, prod: false },
        work: { id: "W-002", state: "in-progress" },
        implements: [{ id: "d-002", state: "decided", confirmed: false }],
        stale: false,
        kind: "flags/flag.kind.mjs",
        path: "flags/new-checkout.flag.md",
      },
    ]);
    expect(doc.members.find((m) => m.name === "blog")!.featureFlags!.map((f) => [f.id, f.stale])).toEqual([["old-banner", true]]);
  });
});
