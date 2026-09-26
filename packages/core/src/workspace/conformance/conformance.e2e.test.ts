/**
 * The reader conformance suite as a reader outside the chant repository runs
 * it (#2679): on the workspace generated from `__fixture__/`, with no
 * test runner, for a subset of the commands, and from the files the package
 * ships.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  checkReaderRead,
  CONFORMANCE_FIXTURE_DIR,
  createConformanceWorkspace,
  READ_CONTRACT_COMMANDS,
  REFERENCE_READS,
  runWorkspaceReaderConformance,
  selectCommands,
  type ChantRun,
  type ChantTransport,
  type ConformanceWorkspace,
  type ReadContractCommand,
} from "./index";
import * as suite from "./index";

const coreRoot = resolve(import.meta.dirname, "..", "..", "..");
const repoRoot = resolve(coreRoot, "..", "..");

const JSON_FLAG: Record<ReadContractCommand, string[]> = {
  ls: ["--json"],
  graph: [],
  check: ["--format", "json"],
  status: ["--json"],
  records: ["--json"],
  "graph --intent": ["--json"],
  "graph --composites": ["--json"],
};

/** The smallest reader that conforms, with a hook to misbehave. */
function reader(twist: (doc: Record<string, unknown>, chant: ChantTransport) => unknown = (doc) => doc) {
  return (chant: ChantTransport) => ({
    async read(command: ReadContractCommand, args: string[]) {
      const run = await chant.run(["workspace", ...command.split(" "), ...args, ...JSON_FLAG[command]]);
      return twist(JSON.parse(run.stdout) as Record<string, unknown>, chant);
    },
  });
}

let ws: ConformanceWorkspace;
beforeAll(() => {
  ws = createConformanceWorkspace();
}, 300_000);
afterAll(() => ws?.dispose());

describe("the generated conformance workspace (#2679)", () => {
  test("a conforming reader passes every command, graph --composites included, with nothing skipped", async () => {
    const report = await runWorkspaceReaderConformance(reader(), { workspaceDir: ws.dir });
    expect(report.problems).toEqual([]);
    expect(report.checked).toEqual([...READ_CONTRACT_COMMANDS]);
    expect(report.skipped).toEqual([]);
  }, 300_000);

  test("graph --composites joins the fixture's composite to its component", async () => {
    const docs: Record<string, unknown>[] = [];
    await runWorkspaceReaderConformance(reader((doc) => (docs.push(doc), doc)), { workspaceDir: ws.dir, commands: ["graph --composites"] });
    expect(docs[0]).toMatchObject({
      composites: [{ id: "delivery/app", kinds: ["WebService"], components: [{ component: "delivery/app", by: "composites", via: "member" }] }],
      summary: { composites: 1, withComponent: 1 },
    });
  }, 300_000);

  test("the decision record and the region the intent read names are in the workspace", async () => {
    const docs: Record<string, unknown>[] = [];
    await runWorkspaceReaderConformance(reader((doc) => (docs.push(doc), doc)), { workspaceDir: ws.dir, commands: ["records", "graph --intent"] });
    expect((docs[0].records as { id: string }[]).map((r) => r.id)).toEqual(["fix-001"]);
    expect(docs[1].region).toBe(`region:${REFERENCE_READS["graph --intent"][0]}`);
  }, 300_000);
});

describe("commands (#2679)", () => {
  test("only the listed commands are read, and the report names the rest as skipped", async () => {
    const read: string[] = [];
    const report = await runWorkspaceReaderConformance(
      (chant) => ({ read: (command, args) => (read.push(command), reader()(chant).read(command, args)) }),
      { workspaceDir: ws.dir, commands: ["status", "ls", "graph --composites"] },
    );
    expect(report.problems).toEqual([]);
    expect(read).toEqual(["ls", "status", "graph --composites"]);
    expect(report.checked).toEqual(["ls", "status", "graph --composites"]);
    expect(report.skipped).toEqual(["graph", "check", "records", "graph --intent"]);
  }, 300_000);

  test("a name that is not a contract command, or an empty list, is refused", () => {
    expect(() => selectCommands(["graph --kind" as ReadContractCommand])).toThrow(/not read-contract commands: graph --kind/);
    expect(() => selectCommands([])).toThrow(/commands is empty/);
  });
});

describe("what the runner-neutral suite catches (#2679)", () => {
  test("a changed document, a reader that throws and a write to the workspace", async () => {
    const changed = await runWorkspaceReaderConformance(reader((doc) => ({ ...doc, extra: 1 })), { workspaceDir: ws.dir, commands: ["ls"] });
    expect(changed.problems.join("\n")).toMatch(/ls: the reader must return the document chant printed, unchanged/);

    const thrown = await runWorkspaceReaderConformance(() => ({ read: () => { throw new Error("no chant"); } }), { workspaceDir: ws.dir, commands: ["status"] });
    expect(thrown.problems).toEqual(["status: the reader threw: no chant"]);

    const wrote = await runWorkspaceReaderConformance(
      reader((doc) => (writeFileSync(join(ws.dir, "cache.json"), "{}"), doc)),
      { workspaceDir: ws.dir, commands: ["ls"] },
    );
    expect(wrote.problems).toEqual(["workspace: the reads changed files: cache.json (added)"]);
  }, 300_000);

  test("checkReaderRead: the schema, the $schema id and the contract version", () => {
    const argv = ["workspace", "ls", "--json"];
    const doc = { $schema: "https://intentius.io/chant/schemas/workspace/ls/v1/ls.schema.json", contract: 2 };
    const printed: ChantRun[] = [{ argv, status: 0, stdout: JSON.stringify(doc), stderr: "" }];
    const problems = checkReaderRead("ls", [], [argv], printed, doc);
    expect(problems.join("\n")).toMatch(/ls: the document does not validate against ls.schema.json/);
    expect(problems.join("\n")).toMatch(/ls: contract is 2, expected 1/);
    expect(checkReaderRead("ls", [], [argv], [{ ...printed[0], stdout: "" }], doc)).toEqual(["ls: chant workspace ls --json printed nothing"]);
  });
});

describe("what the package ships (#2679)", () => {
  const pkg = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf-8")) as { files: string[]; exports: Record<string, Record<string, string>> };

  test("the fixture and both entries are in the package's files and exports", () => {
    expect(pkg.files).toContain("src/");
    for (const key of ["./workspace/conformance", "./workspace/conformance/vitest"]) {
      const entry = pkg.exports[key];
      for (const cond of ["development", "default"]) expect(existsSync(join(coreRoot, entry[cond])), `${key} ${cond}`).toBe(true);
      expect(entry.types).toMatch(/^\.\/dist\/workspace\/conformance\/.+\.d\.ts$/);
    }
    expect(CONFORMANCE_FIXTURE_DIR).toBe(join(coreRoot, "src", "workspace", "conformance", "__fixture__"));
  });

  test("the plain-Node entry re-exports every runtime export of the suite", () => {
    const text = readFileSync(join(import.meta.dirname, "index.mjs"), "utf-8");
    const listed = [.../export const \{([^}]+)\}/.exec(text)![1].matchAll(/[A-Za-z_]+/g)].map((m) => m[0]).sort();
    expect(listed).toEqual(Object.keys(suite).sort());
  });

  test("the fixture's decision kind and schema are the reference workspace's", () => {
    for (const f of ["decision.kind.mjs", "decision.schema.json"]) {
      expect(readFileSync(join(CONFORMANCE_FIXTURE_DIR, "decisions", f), "utf-8"), f).toBe(readFileSync(join(repoRoot, "reference-workspace", "decisions", f), "utf-8"));
    }
  });
});
