/**
 * Which component registered each node (#5403): `IRNode.component` from the
 * stack export's `parent` URNs and from the preview steps. Nothing runs Pulumi.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyDetail } from "@intentius/chant/graph-detail";
import { buildGraphIr, buildLiveGraphIr } from "@intentius/chant/graph-ir";
import { observePreview } from "./preview-observation";
import { readPulumiMember } from "./workspace-member";

const urn = (type: string, name: string) => `urn:pulumi:dev::site::${type}::${name}`;
const STACK = urn("pulumi:pulumi:Stack", "site-dev");
const PROVIDER = urn("pulumi:providers:aws", "default");
const WEB = urn("my:mod:Web", "web");
const DB = urn("my:mod:Db", "db");
const BUCKET = urn("my:mod:Web$aws:s3/bucket:Bucket", "assets");
const TABLE = urn("my:mod:Web$my:mod:Db$aws:dynamodb/table:Table", "orders");
const LOOSE = urn("aws:s3/bucket:Bucket", "loose");

const exported = {
  version: 3,
  deployment: {
    resources: [
      { urn: STACK, type: "pulumi:pulumi:Stack", custom: false },
      { urn: PROVIDER, type: "pulumi:providers:aws", custom: true, parent: STACK },
      { urn: WEB, type: "my:mod:Web", custom: false, parent: STACK },
      { urn: BUCKET, type: "aws:s3/bucket:Bucket", custom: true, id: "assets-1", parent: WEB, provider: `${PROVIDER}::x` },
      { urn: DB, type: "my:mod:Db", custom: false, parent: WEB },
      { urn: TABLE, type: "aws:dynamodb/table:Table", custom: true, id: "orders", parent: DB },
      { urn: LOOSE, type: "aws:s3/bucket:Bucket", custom: true, id: "loose-1", parent: STACK },
    ],
  },
};

function member(doc: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "chant-pulumi-5403-"));
  writeFileSync(join(dir, "stack-export.json"), JSON.stringify(doc));
  return readPulumiMember({ member: { dir, label: "site" } });
}

const id = (type: string, name: string) => `site/${type}::${name}`;

describe("component on the graph read from an export (#5403)", () => {
  const ir = buildGraphIr(member(exported).entities);
  const component = (n: string) => ir.nodes.find((x) => x.id === n)?.component;

  test("a component's children carry the component", () => {
    expect(component(id("my:mod:Web$aws:s3/bucket:Bucket", "assets"))).toBe(id("my:mod:Web", "web"));
  });

  test("nested components nest", () => {
    expect(component(id("my:mod:Web$my:mod:Db$aws:dynamodb/table:Table", "orders"))).toBe(id("my:mod:Db", "db"));
    expect(component(id("my:mod:Db", "db"))).toBe(id("my:mod:Web", "web"));
    expect(component(id("my:mod:Web", "web"))).toBeUndefined();
  });

  test("a resource whose parent is the stack has none", () => {
    expect(component(id("aws:s3/bucket:Bucket", "loose"))).toBeUndefined();
  });

  test("the field is not an attribute and survives detail 1", () => {
    for (const n of ir.nodes) expect(Object.keys(n.attrs)).not.toContain("component");
    const t1 = applyDetail(ir, 1);
    expect(t1.nodes.map((n) => [n.id, n.component])).toEqual(ir.nodes.map((n) => [n.id, n.component]));
  });

  test("a stack with no components renders as before", () => {
    const flat = buildGraphIr(member({ deployment: { resources: [{ urn: STACK, type: "pulumi:pulumi:Stack" }, { urn: LOOSE, type: "aws:s3/bucket:Bucket", parent: STACK }] } }).entities);
    expect(flat.nodes.some((n) => "component" in n)).toBe(false);
  });
});

describe("component on nodes read from a preview (#5403)", () => {
  const step = (op: string, u: string, type: string, parent: string) => ({ op, urn: u, newState: { urn: u, type, parent, custom: !type.startsWith("my:") } });
  const preview = {
    steps: [
      step("create", STACK, "pulumi:pulumi:Stack", ""),
      step("create", WEB, "my:mod:Web", STACK),
      step("create", BUCKET, "aws:s3/bucket:Bucket", WEB),
      step("create", DB, "my:mod:Db", WEB),
      step("create", TABLE, "aws:dynamodb/table:Table", DB),
    ],
  };

  test("planned nodes name their parents, nested", () => {
    const observed = observePreview({ label: "site", preview, declared: new Map() })!;
    const by = (n: string) => observed.resources[n].component;
    expect(by(id("my:mod:Web$aws:s3/bucket:Bucket", "assets"))).toBe(id("my:mod:Web", "web"));
    expect(by(id("my:mod:Web$my:mod:Db$aws:dynamodb/table:Table", "orders"))).toBe(id("my:mod:Db", "db"));
    expect(by(id("my:mod:Db", "db"))).toBe(id("my:mod:Web", "web"));
    expect(by(id("my:mod:Web", "web"))).toBeUndefined();
    const ir = buildLiveGraphIr([{ lexicon: "pulumi", resources: observed.resources }]);
    expect(ir.nodes.find((n) => n.id === id("my:mod:Db", "db"))?.component).toBe(id("my:mod:Web", "web"));
  });

  test("a parent the graph does not hold is left off", () => {
    const only = { steps: [step("create", BUCKET, "aws:s3/bucket:Bucket", WEB)] };
    const observed = observePreview({ label: "site", preview: only, declared: new Map() })!;
    expect(Object.values(observed.resources).every((r) => r.component === undefined)).toBe(true);
  });
});
