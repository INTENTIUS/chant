/**
 * A kind's drift reader (#5068): the kinds file takes `drift.reader` beside
 * `graph`, the loader resolves it inside the package, and `chant workspace
 * drift --member` calls it for a member of the kind, checks what it returns
 * and puts the workspace member on every line. A kind without one still
 * answers `no-drift-read`.
 */

import Ajv2020 from "ajv/dist/2020";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { driftRecord, driftRecordLine, driftSettle, driftStart } from "../drift-record";
import { KIND_DRIFT_READER_FLOOR, NEXT_RELEASE } from "../release-floors";
import { cleanScratch, declaration, repo } from "./__fixtures__/contract-repo";
import { driftReadDocument, readWorkspaceDrift } from "./drift-cli";
import { checkDriftReaderOutput, DRIFT_READER_SCHEMA_ID } from "./drift-reader";
import driftReaderSchema from "./drift-reader.schema.json";
import driftSchema from "./drift.schema.json";
import { readContractSchema } from "./conformance";
import { loadKindRegistry, parseKindData } from "./kinds";
import kindsSchema from "./workspace-kinds.schema.json";

afterAll(cleanScratch);

const at = "2026-11-14T09:00:00Z";
const probe = { anyFile: ["governance.yml"] };
const kind = (extra: Record<string, unknown> = {}) => ({ name: "gov", description: "a forge governance policy", precedence: 500, probe, ...extra });
const kindsFile = (kinds: unknown[]) => JSON.stringify({ schema: 1, kinds });

/** A reader that reports one drifted repo and one in sync, echoing what it was handed in the evidence. */
const DRIFTING = `export default async function read(input) {
  const evidence = { tool: "warden", command: JSON.stringify({ dir: input.dir, config: input.config, read: input.read ?? null, token: process.env.WARDEN_TEST_TOKEN ?? null }) };
  const base = { member: input.member, engine: "warden", observedAt: input.observedAt, read: "live-read", node: null, evidence };
  return {
    lines: [
      { type: "drift-start", drift: "v1", member: input.member, engine: "warden", read: "live-read", at: input.observedAt, expected: ["repo.api", "repo.web", "team.ops"] },
      { type: "drift-record", ...base, address: "repo.api", resourceType: "Repo", status: "drifted", attributes: [{ path: "visibility", before: "private", after: "public" }] },
      { type: "drift-record", ...base, address: "repo.web", resourceType: "Repo", status: "in-sync" },
      { type: "drift-settle", drift: "v1", member: input.member, engine: "warden", read: "live-read", counts: { drifted: 1, "in-sync": 1 }, at: input.observedAt },
    ],
  };
}
`;

/** A reader whose read found nothing to report. */
const QUIET = `export default () => ({ lines: [] });\n`;

/** A reader that refuses every --read but its own. */
const REFUSING = `export default (input) => input.read && input.read !== "live-read" ? { refused: { code: "read-unsupported", message: "the warden reads live-read only" } } : { lines: [] };\n`;

/** A reader that writes a state read saying in-sync, which the drift record refuses. */
const LYING = `export default (input) => ({ lines: [{ type: "drift-record", member: input.member, engine: "warden", address: "x", node: null, observedAt: input.observedAt, read: "state", status: "in-sync", evidence: { tool: "warden" } }] });\n`;

function wardenPackage(name: string, reader: string | null, drift: Record<string, unknown> | null = { reader: "dist/drift-reader.mjs", config: { dir: "{dir}", file: "governance.yml", who: "{member}" } }): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: "1.0.0", exports: { "./workspace-kinds": "./workspace-kinds.json" } }),
    [`node_modules/${name}/workspace-kinds.json`]: kindsFile([kind(drift ? { drift } : {})]),
    ...(reader !== null ? { [`node_modules/${name}/dist/drift-reader.mjs`]: reader } : {}),
  };
}

function workspace(reader: string | null, drift?: Record<string, unknown> | null): string {
  return repo({
    "chant.workspace.json": declaration([{ name: "forge", dir: "org", kind: "gov" }], { pins: [{ package: "@acme/warden", version: "1.0.0" }] }),
    "org/governance.yml": "org: acme\n",
    ".gitignore": "node_modules\n",
    ...wardenPackage("@acme/warden", reader, drift),
  });
}

describe("the kinds file's drift block", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(kindsSchema);

  test("the schema accepts drift.reader with or without config, beside graph", () => {
    expect(validate({ schema: 1, kinds: [kind({ drift: { reader: "dist/drift-reader.mjs" } })] }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ schema: 1, kinds: [kind({ graph: { reader: "dist/graph.mjs" }, drift: { reader: "dist/drift-reader.mjs", config: { dir: "{dir}" }, "x-note": "ours" } })] }), JSON.stringify(validate.errors)).toBe(true);
  });

  test("the schema refuses a drift block with no reader, a path that leaves the package, or an unknown field", () => {
    expect(validate({ schema: 1, kinds: [kind({ drift: { config: {} } })] })).toBe(false);
    expect(validate({ schema: 1, kinds: [kind({ drift: { reader: "/etc/x.mjs" } })] })).toBe(false);
    expect(validate({ schema: 1, kinds: [kind({ drift: { reader: "../x.mjs" } })] })).toBe(false);
    expect(validate({ schema: 1, kinds: [kind({ drift: { reader: "x.mjs", lexicon: "github" } })] })).toBe(false);
  });

  test("parseKindData keeps the block, config defaulting to {}", () => {
    const { kinds, problems } = parseKindData(kindsFile([kind({ drift: { reader: "dist/drift-reader.mjs" } })]), "p");
    expect(problems).toEqual([]);
    expect(kinds[0].drift).toEqual({ reader: "dist/drift-reader.mjs", config: {} });
  });

  test("the loader resolves the reader inside the package, and drops one that is missing", () => {
    const root = repo({ ...wardenPackage("@acme/warden", QUIET), ...wardenPackage("@acme/gone", null) });
    const good = loadKindRegistry([{ package: "@acme/warden", version: "1.0.0", path: null }], root);
    expect(good.problems).toEqual([]);
    expect(good.registry.get("gov")?.drift?.readerFile).toBe(join(root, "node_modules/@acme/warden/dist/drift-reader.mjs"));
    const gone = loadKindRegistry([{ package: "@acme/gone", version: "1.0.0", path: null }], root);
    expect(gone.problems.map((p) => p.message)).toEqual([expect.stringMatching(/drift reader dist\/drift-reader.mjs, which does not exist/)]);
    expect(gone.registry.get("gov")).toBeDefined();
    expect(gone.registry.get("gov")?.drift).toBeUndefined();
  });
});

describe("the drift reader's output schema", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(driftSchema);
  const validate = ajv.compile(driftReaderSchema);

  test("names its $id, and the floor is the next release", () => {
    expect(driftReaderSchema.$id).toBe(DRIFT_READER_SCHEMA_ID);
    expect(KIND_DRIFT_READER_FLOOR).toBe(NEXT_RELEASE);
  });

  test("takes the lines of a read and a refusal, and nothing else", () => {
    const record = driftRecord({ member: "forge", engine: "warden", address: "repo.api", node: null, observedAt: at, read: "live-read", status: "in-sync", evidence: { tool: "warden" } });
    const start = driftStart({ member: "forge", engine: "warden", read: "live-read", at, expected: ["repo.api"] });
    const lines = [start, driftRecordLine(record), driftSettle(start, [record], at).line];
    expect(validate({ lines }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ lines: [] })).toBe(true);
    expect(validate({ refused: { code: "read-unsupported", message: "no" } })).toBe(true);
    expect(validate({ refused: { code: "command-failed", message: "no" } })).toBe(false);
    expect(validate({ lines: [{ type: "drift-nope" }] })).toBe(false);
    expect(validate({ records: [] })).toBe(false);
    expect(checkDriftReaderOutput({ lines })).toEqual({ lines });
    expect(checkDriftReaderOutput({ records: [] })).toEqual({ error: expect.stringMatching(/no lines array/) });
  });
});

describe("chant workspace drift --member over a kind's drift reader", () => {
  test("runs the reader with the substituted config and the environment, and prints its records for the member", async () => {
    const root = workspace(DRIFTING);
    process.env.WARDEN_TEST_TOKEN = "t0ken";
    try {
      const answer = await readWorkspaceDrift({ cwd: root, member: "forge" });
      if ("error" in answer) throw new Error(`${answer.error.code}: ${answer.error.message}`);
      const doc = driftReadDocument("forge", answer);
      const { validate } = readContractSchema("drift");
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(doc.error).toBeUndefined();
      expect(doc.records.map((r) => [r.member, r.engine, r.address, r.status])).toEqual([
        ["forge", "warden", "repo.api", "drifted"],
        ["forge", "warden", "repo.web", "in-sync"],
        ["forge", "warden", "team.ops", "not-observed"],
      ]);
      expect(doc.records[2].unobserved?.reason).toBe("not-reached");
      expect(JSON.parse(doc.records[0].evidence.command!)).toEqual({
        dir: join(root, "org"),
        config: { dir: join(root, "org"), file: "governance.yml", who: "forge" },
        read: null,
        token: "t0ken",
      });
    } finally {
      delete process.env.WARDEN_TEST_TOKEN;
    }
  });

  test("a reader that finds nothing answers an empty document, not an error", async () => {
    const answer = await readWorkspaceDrift({ cwd: workspace(QUIET), member: "forge" });
    expect(answer).toEqual({ lines: [] });
    const doc = driftReadDocument("forge", answer);
    expect(doc.records).toEqual([]);
    expect(doc.error).toBeUndefined();
  });

  test("--read passes through, and the reader's refusal is the document's error", async () => {
    const root = workspace(REFUSING);
    const refused = await readWorkspaceDrift({ cwd: root, member: "forge", read: "state" });
    expect(refused).toEqual({ error: { code: "read-unsupported", message: "forge: the warden reads live-read only" } });
    expect(await readWorkspaceDrift({ cwd: root, member: "forge", read: "live-read" })).toEqual({ lines: [] });
    const bad = await readWorkspaceDrift({ cwd: root, member: "forge", read: "nope" });
    expect("error" in bad && bad.error.code).toBe("read-unsupported");
  });

  test("a line the drift record refuses fails the read with command-failed", async () => {
    const answer = await readWorkspaceDrift({ cwd: workspace(LYING), member: "forge" });
    expect("error" in answer && answer.error.code).toBe("command-failed");
    expect("error" in answer && answer.error.message).toMatch(/is not drift/);
  });

  test("a kind with no drift reader still answers no-drift-read", async () => {
    const answer = await readWorkspaceDrift({ cwd: workspace(null, null), member: "forge" });
    expect("error" in answer && answer.error.code).toBe("no-drift-read");
    expect("error" in answer && answer.error.message).toMatch(/forge is kind gov, and chant workspace drift reads members of kind chant, terraform, choudoufu, pulumi$/);
  });

  test("a kind whose drift reader is missing from the package answers no-drift-read and says why", async () => {
    const answer = await readWorkspaceDrift({ cwd: workspace(null), member: "forge" });
    expect("error" in answer && answer.error.code).toBe("no-drift-read");
    expect("error" in answer && answer.error.message).toMatch(/names drift reader dist\/drift-reader.mjs, which does not exist/);
  });
});
