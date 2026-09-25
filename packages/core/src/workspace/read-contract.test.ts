/**
 * The read contract as a whole (#2536, #2524 D15): every output schema, run
 * against the reference workspace (#2543) in this checkout.
 *
 * `reference-workspace/` is a nested workspace of the chant repo, with a
 * `chant` member (`delivery`), three `other` members and decision records.
 * Each read-contract command reads it here, and its output must validate
 * against the command's schema: `ls`, `graph` (running delivery's real
 * `chant graph`), `graph --composites`, `check`, `status`, `records` and
 * `records --since`, in the working tree and, for `ls`, `graph` and `check`,
 * at `HEAD` through `--at`.
 *
 * The schemas themselves are checked here too: each is a draft 2020-12
 * document under `https://intentius.io/chant/schemas/workspace/<command>/v1/`,
 * at the contract version this chant writes, naming the chant floor.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { contract, git, REPO, validSchema } from "./__fixtures__/contract-repo";
import checkSchema from "./check.schema.json";
import { workspaceComposites } from "./composites";
import compositesSchema from "./composites.schema.json";
import { workspaceGraph } from "./graph-cli";
import graphSchema from "./graph.schema.json";
import { intentGraph } from "./intent";
import intentSchema from "./intent.schema.json";
import { runChecks } from "./lineage-check";
import { listWorkspace } from "./ls";
import lsSchema from "./ls.schema.json";
import { readerBin, type Toolchain } from "./member-commands";
import { READ_CONTRACT_FLOOR, READ_CONTRACT_VERSION } from "./reason-codes";
import { queryRecords } from "./records-cli";
import recordsSchema from "./records.schema.json";
import { queryRecordsSince } from "./records-since";
import recordsSinceSchema from "./records-since.schema.json";
import { workspaceStatus } from "./status";
import statusSchema from "./status.schema.json";

const FIXTURE = join(REPO, "reference-workspace");
const TIMEOUT = 240_000;

const SCHEMAS = { ls: lsSchema, graph: graphSchema, check: checkSchema, status: statusSchema, records: recordsSchema, "records-since": recordsSinceSchema, intent: intentSchema, composites: compositesSchema };

/** This checkout's chant, started the way the CLI starts it, for members with no toolchain of their own. */
const reader: Toolchain = {
  command: [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")],
  identity: realpathSync(readerBin()),
  source: "reader",
};

describe("the read contract's schemas", () => {
  test.each(Object.entries(SCHEMAS))("%s is a valid draft 2020-12 document at the contract version, naming the floor", (name, schema) => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(`https://intentius.io/chant/schemas/workspace/${name}/v${READ_CONTRACT_VERSION}/${name}.schema.json`);
    for (const branch of ["result", "failure"] as const) {
      const props = (schema.$defs as Record<string, { properties: Record<string, unknown> }>)[branch].properties;
      expect(props.contract, `${name} ${branch}`).toEqual({ const: READ_CONTRACT_VERSION });
      expect(props.$schema, `${name} ${branch}`).toEqual({ const: schema.$id });
    }
    expect(schema.description).toContain(`chant ${READ_CONTRACT_FLOOR} and newer`);
  });
});

describe("every schema against the reference workspace (#2543)", () => {
  const head = git(REPO, "rev-parse", "HEAD");

  test("ls, in the working tree and at HEAD", () => {
    const { expectValid } = contract(lsSchema);
    for (const at of [undefined, "HEAD"]) {
      const doc = listWorkspace({ cwd: join(FIXTURE, "delivery"), at });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.workspace).toMatchObject({ name: "reference", root: "reference-workspace" });
      expect(doc.at).toBe(at ? head : null);
      expect(doc.members.map((m) => [m.name, m.readable])).toEqual([
        ["app", true],
        ["delivery", true],
        ["design-client", true],
        ["design", true],
      ]);
    }
  });

  test(
    "graph runs delivery's own chant graph, in the working tree and at HEAD",
    async () => {
      const { expectValid } = contract(graphSchema);
      for (const at of [undefined, "HEAD"]) {
        const { doc, failed } = await workspaceGraph({ cwd: FIXTURE, at, reader });
        expectValid(doc);
        if ("error" in doc) throw new Error(doc.error.message);
        expect(failed, JSON.stringify(doc.members)).toBe(false);
        expect(doc.workspace).toEqual({ name: "reference", root: "reference-workspace" });
        expect(doc.at).toBe(at ? head : null);
        const delivery = doc.members.find((m) => m.name === "delivery");
        expect(delivery).toMatchObject({ status: "composed", reason: null, irVersion: 1 });
        expect(doc.groups.byMember.delivery.length).toBeGreaterThan(0);
        expect(doc.nodes.every((n) => n.id.startsWith("delivery/") && n.member === "delivery")).toBe(true);
      }
    },
    TIMEOUT,
  );

  test("check, in the working tree and at HEAD", async () => {
    const { expectValid } = contract(checkSchema);
    for (const at of [undefined, "HEAD"]) {
      const doc = await runChecks(FIXTURE, at);
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.workspace).toEqual({ name: "reference", root: "reference-workspace" });
      expect(doc.declaration?.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    }
  });

  test("status", async () => {
    const doc = await workspaceStatus({ cwd: FIXTURE, env: "dev" });
    contract(statusSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.workspace).toMatchObject({ name: "reference", root: "reference-workspace" });
    expect(doc.members.map((m) => m.name)).toEqual(["app", "delivery", "design-client", "design"]);
  });

  test("graph --intent, in the working tree and at HEAD (#2651)", async () => {
    const { expectValid } = contract(intentSchema);
    for (const at of [undefined, "HEAD"]) {
      const { doc, failed } = await intentGraph({ cwd: FIXTURE, region: "app/src/server.mjs:19", at, kinds: ["decisions/decision.kind.mjs"] });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(failed).toBe(false);
      expect(doc.workspace).toEqual({ name: "reference", root: "reference-workspace" });
      expect(doc.at).toBe(at ? head : null);
      expect(doc.region).toBe("region:app/src/server.mjs:19");
    }
  });

  test(
    "graph --composites runs delivery's own component graph, and lists its app with the component that deploys it (#2662)",
    async () => {
      const { expectValid } = contract(compositesSchema);
      for (const at of [undefined, "HEAD"]) {
        const { doc, failed } = await workspaceComposites({ cwd: FIXTURE, at, reader });
        expectValid(doc);
        if ("error" in doc) throw new Error(doc.error.message);
        expect(failed, JSON.stringify(doc.members)).toBe(false);
        expect(doc.at).toBe(at ? head : null);
        expect(doc.members.map((m) => [m.name, m.status])).toEqual([
          ["app", "skipped"],
          ["delivery", "read"],
          ["design-client", "skipped"],
          ["design", "skipped"],
        ]);
        // delivery declares the app as a DockerWebService, and its app component names that kind.
        expect(doc.composites.map((c) => [c.id, c.kinds, c.components.map((m) => [m.component, m.by, m.via])])).toEqual([
          ["delivery/app", ["DockerWebService"], [["delivery/app", "composites", "member"]]],
        ]);
        expect(doc.components.map((c) => [c.id, c.archetype])).toEqual([["delivery/app", "service"]]);
        // #2674: the reference config's lexicons host no component runs, so local is the only runtime, read at HEAD too.
        expect(doc.components[0].runtimes).toEqual([{ name: "local", lexicon: null, default: true, command: "chant run --components app" }]);
        expect(doc.members.find((m) => m.name === "delivery")!.runtimeReasons).toEqual([]);
        // #2695: the reference config declares no environments, so the app deploys to local only.
        expect(doc.components[0].environments).toEqual([{ name: "local", default: true, source: "builtin", command: "chant run --components app" }]);
        expect(doc.members.find((m) => m.name === "delivery")!.environmentReasons.map((r) => r.code)).toEqual(["environments-none-declared"]);
        expect(doc.reasons).toEqual([]);
      }
    },
    TIMEOUT,
  );

  test("records, in the working tree and at HEAD", async () => {
    const { expectValid } = contract(recordsSchema);
    for (const at of [undefined, "HEAD"]) {
      const doc = await queryRecords({ kind: "decisions/decision.kind.mjs", cwd: FIXTURE, at });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.summary.invalid).toBe(0);
      expect(doc.records.map((r) => r.id)).toContain("ref-001");
    }
    const sessions = await queryRecords({ kind: "design/sessions/session.kind.mjs", cwd: FIXTURE });
    expectValid(sessions);
    if ("error" in sessions) throw new Error(sessions.error.message);
    expect(sessions.summary.invalid).toBe(0);
  });

  test("records --since HEAD, for decisions and sessions (#2673)", async () => {
    const { expectValid } = contract(recordsSinceSchema);
    for (const kind of ["decisions/decision.kind.mjs", "design/sessions/session.kind.mjs"]) {
      const doc = await queryRecordsSince({ kind, since: "HEAD", cwd: FIXTURE });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.since).toBe(head);
    }
  });
});
