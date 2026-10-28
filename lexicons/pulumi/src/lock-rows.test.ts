/**
 * #4552: the rows a plunge apply holds on the resource grain: `urn` rows,
 * `object` rows for anything but a create, the root stack's row when its
 * outputs change, and the `stack` row in place of the URN rows when
 * something may appear only at apply (ruling C).
 */
import { describe, expect, test } from "vitest";
import type { ChangeSetEntry, ChangeSetPart } from "@intentius/chant/change-set";
import { pulumiLockRows } from "./lock-rows";

const urn = (type: string, name: string) => `urn:pulumi:dev::site::${type}::${name}`;
const STACK = urn("pulumi:pulumi:Stack", "site-dev");
const BUCKET = urn("aws:s3/bucket:Bucket", "logs");
const QUEUE = urn("aws:sqs/queue:Queue", "jobs");
const TABLE = urn("aws:dynamodb/table:Table", "state");

const entry = (address: string, action: ChangeSetEntry["action"], extra: Partial<ChangeSetEntry> = {}): ChangeSetEntry => ({
  member: "site/dev",
  lexicon: "pulumi",
  planner: "pulumi",
  address,
  type: "t",
  action,
  scope: "dev",
  attributes: [],
  ...extra,
});

const part = (entries: ChangeSetEntry[]): ChangeSetPart => ({
  member: { member: "site/dev", lexicon: "pulumi", planner: "pulumi", scope: "dev", status: "planned", planDigest: "sha256:x", holes: [] },
  entries,
});

describe("pulumiLockRows", () => {
  test("a URN row per change, an object row for anything but a create, nothing for same and read", () => {
    const rows = pulumiLockRows(
      part([entry(BUCKET, "update", { id: "logs-1" }), entry(QUEUE, "create"), entry(TABLE, "no-op", { id: "state-1" }), entry(STACK, "no-op")]),
      "site/dev",
    );
    expect(rows.map((r) => r.key)).toEqual(["object logs-1", `urn ${BUCKET}`, `urn ${QUEUE}`]);
    expect(rows.every((r) => r.target === "site/dev")).toBe(true);
  });

  test("the root stack's row when its outputs change, so two runs that rewrite them serialize", () => {
    const rows = pulumiLockRows(part([entry(STACK, "update"), entry(BUCKET, "create")]), "site/dev");
    expect(rows.map((r) => r.key)).toContain(`urn ${STACK}`);
  });

  test("a may-appear entry turns the URN rows into the stack's row, and keeps the object rows", () => {
    const appear = `urn:pulumi:dev::site::my:web:Site$*::site/*`;
    const rows = pulumiLockRows(part([entry(BUCKET, "delete", { id: "logs-1" }), entry(appear, "create", { mayAppear: true })]), "site/dev");
    expect(rows.map((r) => r.key)).toEqual(["object logs-1", "stack site/dev"]);
  });

  test("with no URN to read the stack from, the step's project and stack key the row", () => {
    const rows = pulumiLockRows(part([entry("not-a-urn", "create", { mayAppear: true })]), "site/dev", { project: "site", stack: "dev" });
    expect(rows.map((r) => r.key)).toEqual(["stack site/dev"]);
    expect(() => pulumiLockRows({ ...part([entry("not-a-urn", "create", { mayAppear: true })]), member: { ...part([]).member, scope: undefined } }, "site/dev")).toThrow(/cannot be keyed/);
  });
});
