/**
 * The reference workspace (#2543, #2524 D21) as chant's integration fixture.
 *
 * `reference-workspace/` is a level 1 workspace: its `chant.workspace.json`
 * (#2534) declares four members. This file checks it against the commit under
 * test rather than a released chant:
 *
 * - the declaration validates against chant's declaration schema, and the
 *   members it names are on disk;
 * - `chant workspace ls --json` lists them with their kinds and roles, and
 *   `chant workspace check` exits 0;
 * - the app's own test passes;
 * - the delivery member builds and lints with no findings, and the Compose
 *   file it writes points at the app's Dockerfile;
 * - the decision files validate against chant's decision schema, and
 *   `chant workspace records` reads them through the fixture's own kind file,
 *   which must stay the same as chant's.
 * - the design member's review-session kind (#2673) reads its one closed
 *   session as sealed and valid.
 *
 * - `chant init --from <this repo>@HEAD#reference-workspace` copies it with a
 *   lineage lock (#2540), and the copy is a working workspace: it reads its
 *   decisions on its own, `workspace ls` lists the same members and
 *   `workspace check` passes.
 * - its `chant.template.json` declares a `name` parameter (#2627), and
 *   `--param name=<value>` puts the value in the app and the screen spec.
 * - `chant init --from <this repo>#reference-workspace`, the directory form
 *   (#2647), copies the same files with the same parameters and digest as
 *   the git form, with a lock that records the digest alone.
 *
 * - `chant workspace graph --composites` (#2662) lists one composite
 *   instance, delivery's `app` (a docker `DockerWebService`), with the `app`
 *   component that names that kind in its `composites`, matched in the same
 *   member, and no reason.
 *
 * - `chant workspace graph --intent app/src/server.mjs:19` (#2651) lists
 *   ref-001 and ref-002 by member, the commit that wrote line 19, and the
 *   findings #2651's acceptance names. No decision constrains the line by
 *   path, so no commit is inside a decision's window (#2656).
 * - the work items W-001 and W-002 (#2683) validate against the work schema
 *   beside them, `records` reads W-002 as blocked by W-001, and
 *   `graph --intent design/screens/home.json` with the work kind shows both,
 *   with the implements and needs edges. `init --from` carries them.
 * - the record-decisions skill and prompt (#2709) exist with skill
 *   frontmatter, the skill's example record validates against the decision
 *   schema, and `init --from` carries both files.
 *
 * - the decision points (ws-058, #2741) validate: finding triage, needs a
 *   decision, slice tier and ship skip. On a copy, a finding graph --intent
 *   reports is asked through the decide activity, a stub decider's answer is
 *   a proposal, the work item written from it opens proposed with its
 *   proposer in proposed_by, and a person keeps both.
 *
 * The per-member workspace commands and their contract tests join here as
 * each phase lands (#2537, #2536).
 */

import { describe, expect, test } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { buildCommand } from "@intentius/chant/cli/commands/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { loadPlugins, resolveProjectLexicons } from "@intentius/chant/cli";
import { parseFrontMatter } from "@intentius/chant/workspace/records";
import { queryRecords } from "@intentius/chant/workspace/records-cli";
import { initFromCommand } from "@intentius/chant/workspace/lineage-init";
import { parseDeclaration } from "@intentius/chant/workspace/declaration";
import { candidates, parsePoints, quorumOf } from "@intentius/chant/workspace/points";
import { askPoint } from "@intentius/chant/workspace/decide";
import { isPointWait } from "@intentius/chant/op";
import { startStubBackend } from "@intentius/chant-lexicon-systemone";
import { runDecide } from "@intentius/chant-lexicon-systemone/op/activities/decide";

const repoRoot = resolve(import.meta.dirname, "..");
const fixture = join(repoRoot, "reference-workspace");
const chantDecisions = join(repoRoot, "docs", "design", "decisions");
const workspaceSrc = join(repoRoot, "packages", "core", "src", "workspace");
const declarationSchema = JSON.parse(readFileSync(join(workspaceSrc, "declaration.schema.json"), "utf-8")) as object;
const lsSchema = JSON.parse(readFileSync(join(workspaceSrc, "ls.schema.json"), "utf-8")) as object;
const decisionsDir = join(fixture, "decisions");

interface DeclaredMember {
  name: string;
  dir: string;
  kind: string;
  roles?: string[];
  because?: string;
}

const declarationText = readFileSync(join(fixture, "chant.workspace.json"), "utf-8");
const declaration = JSON.parse(declarationText) as {
  name: string;
  schema: number;
  members: DeclaredMember[];
  pins: unknown[];
};

/** The four members #2543 asks for, as `workspace ls --json` shows them. */
const EXPECTED_MEMBERS = [
  { name: "app", dir: "app", kind: "other", roles: [] },
  { name: "delivery", dir: "delivery", kind: "chant", roles: [] },
  { name: "design-client", dir: "design-client", kind: "other", roles: [{ name: "design-app", path: null }] },
  { name: "design", dir: "design", kind: "other", roles: [] },
];

const CLI_TIMEOUT_MS = 60_000;

type Validate = ((d: unknown) => boolean) & { errors?: unknown };
/** A draft 2020-12 validator, from core's own ajv 8 (the repo root hoists ajv 6). */
function compile2020(schema: object): Validate {
  const mod = createRequire(join(repoRoot, "packages", "core", "package.json"))("ajv/dist/2020") as { default?: unknown };
  const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): Validate };
  return new Ajv({ strict: true, allErrors: true }).compile(schema);
}

/** node's own argv for a `chant` invocation: the tsx loader hook, then the CLI entry, then `args`. */
function chantArgv(...args: string[]): string[] {
  return ["--import", pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href, join(repoRoot, "packages/core/src/cli/main.ts"), ...args];
}

/** Run this checkout's chant CLI in `cwd`, as a user would. */
function chant(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, chantArgv(...args), { cwd, encoding: "utf-8", timeout: CLI_TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1" } });
}

/**
 * Same as `chant`, but non-blocking: the child runs while the caller does other
 * work on the main thread, instead of the two serializing (chant #2777, ws-058).
 */
function chantAsync(cwd: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, chantArgv(...args), { cwd, timeout: CLI_TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", rej);
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
}

interface LsMemberJson {
  name: string;
  dir: string;
  kind: string;
  roles: { name: string; path: string | null }[];
  because: string | null;
  readable: boolean;
  reason: unknown;
}

/** `chant workspace ls --json` in `cwd`, checked against the ls output schema. */
function lsJson(cwd: string): { workspace: { name: string; root: string; file: string; pins: unknown[] }; members: LsMemberJson[]; groups: unknown[]; summary: { members: number; unreadable: number } } {
  const run = chant(cwd, "workspace", "ls", "--json");
  expect(run.status, run.stderr).toBe(0);
  const doc = JSON.parse(run.stdout);
  const validate = compile2020(lsSchema);
  expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  return doc;
}

function expectTheFourMembers(members: LsMemberJson[]): void {
  expect(members.map(({ name, dir, kind, roles }) => ({ name, dir, kind, roles }))).toEqual(EXPECTED_MEMBERS);
  for (const m of members) {
    expect(m.readable, `${m.name}: ${JSON.stringify(m.reason)}`).toBe(true);
    if (m.kind === "other") expect(m.because, `${m.name} is kind other with no because`).toBeTruthy();
  }
}

/** Every path under `dir`, relative to it, skipping node_modules and dist. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

describe("reference workspace layout", () => {
  test("the declaration validates against declaration.schema.json", () => {
    const validate = compile2020(declarationSchema);
    expect(validate(declaration), JSON.stringify(validate.errors, null, 2)).toBe(true);
    // The rules JSON Schema cannot say (unique names, placement) are checked in code.
    const parsed = parseDeclaration(declarationText, "chant.workspace.json");
    expect(parsed.name).toBe("reference");
    expect(parsed.schema).toBe(1);
    expect(declaration.pins).toEqual([]);
  });

  test("it declares the four members #2543 asks for", () => {
    const byName = new Map(declaration.members.map((m) => [m.name, m]));
    expect([...byName.keys()].sort()).toEqual(["app", "delivery", "design", "design-client"]);
    expect(byName.get("delivery")?.kind).toBe("chant");
    expect(byName.get("design-client")?.roles).toEqual(["design-app"]);
    for (const m of declaration.members) {
      if (m.kind === "other") expect(m.because, `${m.name} is kind other with no because`).toBeTruthy();
    }
  });

  test("every member directory exists", () => {
    for (const m of declaration.members) {
      expect(existsSync(join(fixture, m.dir)), `${m.dir} is missing`).toBe(true);
    }
  });

  test("its declaration is the only one in it, and no draft is left", () => {
    const declarations = walk(fixture).filter((p) => /(^|\/)chant\.workspace(\.draft)?\.jsonc?$/.test(p));
    expect(declarations).toEqual(["chant.workspace.json"]);
  });

  test("the chant repo's own declaration holds it as a nested workspace", () => {
    const outer = JSON.parse(readFileSync(join(repoRoot, "chant.workspace.json"), "utf-8")) as { members: { dir?: string; kind: string }[] };
    expect(outer.members.find((m) => m.dir === "reference-workspace")?.kind).toBe("workspace");
  });

  test("only delivery is a chant project", () => {
    const configs = walk(fixture).filter((p) => /(^|\/)chant\.config\.[a-z]+$/.test(p));
    expect(configs).toEqual(["delivery/chant.config.ts"]);
  });
});

describe("app member", () => {
  test("its own test passes", () => {
    const appDir = join(fixture, "app");
    const tests = readdirSync(join(appDir, "test")).filter((f) => f.endsWith(".test.mjs"));
    expect(tests.length).toBeGreaterThan(0);
    // Throws, with node's output, when a test fails.
    execFileSync(process.execPath, ["--test", ...tests.map((f) => join("test", f))], {
      cwd: appDir,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });
});

describe("delivery member", () => {
  const delivery = join(fixture, "delivery");

  test("builds, and the Compose file builds the app from its Dockerfile", async () => {
    const src = join(delivery, "src");
    const plugins = await loadPlugins(await resolveProjectLexicons(src));
    const serializers = plugins.map((p) => p.serializer).filter((s) => s.name === "docker");
    expect(serializers).toHaveLength(1);

    const out = mkdtempSync(join(tmpdir(), "chant-2543-delivery-"));
    try {
      const output = join(out, "docker-compose.yml");
      const result = await buildCommand({ path: src, output, format: "yaml", serializers, plugins });
      expect(result.errors, result.errors.join("\n")).toEqual([]);
      expect(result.warnings, result.warnings.join("\n")).toEqual([]);
      expect(result.success).toBe(true);

      const compose = yaml.load(readFileSync(output, "utf-8")) as {
        services: Record<string, { build?: { context: string; dockerfile: string } }>;
      };
      // DockerWebService keys the service by the export name plus `Service` (#2662).
      expect(Object.keys(compose.services)).toEqual(["appService"]);
      const build = compose.services.appService?.build;
      expect(build).toBeDefined();
      // The package.json build script writes the file to delivery/dist/, and
      // Compose resolves the context from the file's own directory.
      const context = resolve(delivery, "dist", build!.context);
      expect(context).toBe(join(fixture, "app"));
      expect(existsSync(join(context, build!.dockerfile))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("the package.json build script writes to dist/", () => {
    const pkg = JSON.parse(readFileSync(join(delivery, "package.json"), "utf-8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe("chant build src --lexicon docker -o dist/docker-compose.yml");
    expect(pkg.scripts.lint).toBe("chant lint src");
  });

  test("lints with no findings", async () => {
    const result = await lintCommand({ path: join(delivery, "src"), format: "stylish", fix: false });
    expect(result.errorCount, result.output).toBe(0);
    expect(result.warningCount, result.output).toBe(0);
    expect(result.success).toBe(true);
  });
});

describe("decision files", () => {
  const files = readdirSync(decisionsDir)
    .filter((f) => /^[a-z][a-z0-9]{0,15}-[0-9]{3,}-.+\.md$/.test(f))
    .sort();

  test("there are some, all with the fixture's own ref- prefix", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^ref-[0-9]{3}-/);
  });

  test("the schema beside them is chant's decision schema, byte for byte", () => {
    expect(readFileSync(join(decisionsDir, "decision.schema.json"), "utf-8")).toBe(
      readFileSync(join(chantDecisions, "decision.schema.json"), "utf-8"),
    );
  });

  test("the kind beside them is chant's decision kind", async () => {
    const ours = (await import(join(decisionsDir, "decision.kind.mjs"))) as { recordKind: unknown };
    const chants = (await import(join(chantDecisions, "decision.kind.mjs"))) as { recordKind: unknown };
    expect(ours.recordKind).toEqual(chants.recordKind);
  });

  test("each validates against docs/design/decisions/decision.schema.json", async () => {
    const mod = (await import("ajv")) as unknown as { default: unknown };
    const Ajv = ((mod.default as { default?: unknown }).default ?? mod.default) as new (opts: object) => {
      compile(s: object): ((d: unknown) => boolean) & { errors?: unknown };
    };
    const schema = JSON.parse(readFileSync(join(chantDecisions, "decision.schema.json"), "utf-8")) as object;
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    for (const f of files) {
      const fm = parseFrontMatter(readFileSync(join(decisionsDir, f), "utf-8"));
      expect(fm.ok, `${f}: ${fm.ok ? "" : fm.message}`).toBe(true);
      if (!fm.ok) continue;
      expect(validate(fm.value), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(f.startsWith(`${fm.value.id as string}-`), `${f} does not start with its id`).toBe(true);
      for (const c of fm.value.constrains as string[]) {
        if (!c.startsWith("member:")) continue;
        expect(
          declaration.members.map((m) => m.name),
          `${f} constrains ${c}, which the declaration does not declare`,
        ).toContain(c.slice("member:".length));
      }
    }
  });

  test("pass the decision checker's cross-file rules", () => {
    execFileSync(process.execPath, [join(repoRoot, "scripts", "import-decisions.mjs"), "--check", "--dir", decisionsDir], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  test("chant workspace records reads them through the fixture's kind", async () => {
    const doc = await queryRecords({ kind: "decisions/decision.kind.mjs", current: true, cwd: fixture });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.kind.name).toBe("decision");
    expect(doc.kind.file).toBe("reference-workspace/decisions/decision.kind.mjs");
    expect(doc.records.map((r) => r.id)).toEqual(files.map((f) => f.slice(0, "ref-000".length)));
    expect(doc.summary.invalid, JSON.stringify(doc.records.flatMap((r) => r.reasons))).toBe(0);
    for (const r of doc.records) expect(dirname(r.path)).toBe("reference-workspace/decisions");
  });

  test("the declaration names the decision, work, answer and session kinds, so ls lists them and records reads them without --kind (#2680, #2683, ws-058)", async () => {
    const ls = lsJson(fixture) as unknown as { workspace: { records: unknown[] }; members: { name: string; records: unknown[] }[] };
    expect(ls.workspace.records).toEqual([
      { name: "decision", path: "decisions/decision.kind.mjs", kind: "decision", reason: null, acceptance: null },
      // W-001 states two acceptance criteria and has no evidence for them yet (#2772).
      { name: "work", path: "work/work.kind.mjs", kind: "work", reason: null, acceptance: [{ item: "W-001", state: "in-progress", met: 0, total: 2 }] },
      { name: "answer", path: "answers/answer.kind.mjs", kind: "answer", reason: null, acceptance: null },
    ]);
    expect(ls.members.find((m) => m.name === "design")!.records).toEqual([
      { name: "session", path: "design/sessions/session.kind.mjs", kind: "session", reason: null, acceptance: null },
    ]);
    const run = chant(fixture, "workspace", "records", "--current", "--json");
    expect(run.status, run.stderr).toBe(0);
    const set = JSON.parse(run.stdout) as { kinds: { kind: { name: string }; declared: unknown; records: { id: string }[] }[] };
    expect(set.kinds.map((k) => [k.kind.name, k.declared])).toEqual([
      ["decision", { member: null, path: "decisions/decision.kind.mjs", name: null }],
      ["work", { member: null, path: "work/work.kind.mjs", name: null }],
      ["answer", { member: null, path: "answers/answer.kind.mjs", name: null }],
      ["session", { member: "design", path: "design/sessions/session.kind.mjs", name: null }],
    ]);
    expect(set.kinds[0].records.map((r) => r.id)).toEqual(files.map((f) => f.slice(0, "ref-000".length)));
  });

  test("ref-002 pins design/screens/home.json by hash, and the pin holds (#2549)", async () => {
    const doc = await queryRecords({ kind: "decisions/decision.kind.mjs", current: true, cwd: fixture });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.workspaceRoot).toBe("reference-workspace");
    const ref002 = doc.records.find((r) => r.id === "ref-002")!;
    expect(ref002.assets.map((a) => [a.path, a.state])).toEqual([["design/screens/home.json", "pinned"]]);
    expect(ref002.assets[0].sha256).toBe(createHash("sha256").update(readFileSync(join(fixture, "design", "screens", "home.json"))).digest("hex"));
    expect(doc.records.flatMap((r) => r.warnings)).toEqual([]);
  });

  test("editing the pinned file makes records report asset-drift, and the decision stays valid (#2549)", async () => {
    const copy = mkdtempSync(join(tmpdir(), "chant-2549-ref-"));
    try {
      for (const d of ["decisions", "design"]) cpSync(join(fixture, d), join(copy, d), { recursive: true });
      cpSync(join(fixture, "chant.workspace.json"), join(copy, "chant.workspace.json"));
      writeFileSync(join(copy, "design", "screens", "home.json"), readFileSync(join(fixture, "design", "screens", "home.json"), "utf-8").replace('"route": "/"', '"route": "/home"'));
      const doc = await queryRecords({ kind: "decisions/decision.kind.mjs", current: true, cwd: copy });
      if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
      const ref002 = doc.records.find((r) => r.id === "ref-002")!;
      expect(ref002.valid).toBe(true);
      expect(ref002.assets.map((a) => a.state)).toEqual(["drifted"]);
      expect(ref002.warnings.map((w) => w.code)).toEqual(["asset-drift"]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe("review sessions (#2673)", () => {
  test("the design member's session kind reads S-0001 as closed, sealed and valid, with its verdicts checked against the decisions", async () => {
    const doc = await queryRecords({ kind: "design/sessions/session.kind.mjs", cwd: fixture });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.kind).toMatchObject({ name: "session", file: "reference-workspace/design/sessions/session.kind.mjs" });
    expect(doc.records.map((r) => [r.id, r.state, r.valid, r.reasons])).toEqual([["S-0001", "closed", true, []]]);
    expect(doc.records[0].citedBy).toEqual([]);
  });
});

describe("record-decisions skill and prompt (#2709)", () => {
  const skillFile = join(fixture, "skills", "record-decisions", "SKILL.md");
  const promptFile = join(fixture, "docs", "record-decisions.md");

  test("the skill has the frontmatter every harness reads, and the prompt is a plain file beside it", () => {
    const skill = readFileSync(skillFile, "utf-8");
    expect(skill).toMatch(/^---\nname: record-decisions\ndescription: .+\n---\n/);
    const prompt = readFileSync(promptFile, "utf-8");
    expect(prompt.startsWith("# ")).toBe(true);
  });

  test("the skill's example record validates against docs/design/decisions/decision.schema.json", async () => {
    const skill = readFileSync(skillFile, "utf-8");
    const m = skill.match(/<!-- example-record[^>]*-->\r?\n```json\r?\n([\s\S]*?)\r?\n```/);
    expect(m, "no example-record block found in skills/record-decisions/SKILL.md").not.toBeNull();
    const record = JSON.parse(m![1]) as Record<string, unknown>;

    const mod = (await import("ajv")) as unknown as { default: unknown };
    const Ajv = ((mod.default as { default?: unknown }).default ?? mod.default) as new (opts: object) => {
      compile(s: object): ((d: unknown) => boolean) & { errors?: unknown };
    };
    const schema = JSON.parse(readFileSync(join(chantDecisions, "decision.schema.json"), "utf-8")) as object;
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(validate(record), JSON.stringify(validate.errors, null, 2)).toBe(true);

    // The example is a proposal, the only state this skill ever writes.
    expect(record.state).toBe("proposed");
    expect(record.choice).toBeNull();
    expect(record.decided_by).toBeNull();
  });
});

describe("workspace commands on the fixture", () => {
  test("workspace ls --json lists the four members with their kinds and roles", () => {
    const doc = lsJson(fixture);
    expect(doc.workspace).toMatchObject({ name: "reference", root: "reference-workspace", file: "chant.workspace.json", pins: [] });
    expectTheFourMembers(doc.members);
    expect(doc.groups).toEqual([]);
    expect(doc.summary).toMatchObject({ members: 4, unreadable: 0 });
  });

  test("workspace ls finds the declaration from inside a member", () => {
    expect(lsJson(join(fixture, "delivery")).workspace.name).toBe("reference");
  });

  test("workspace check exits 0", () => {
    const run = chant(fixture, "workspace", "check", "--json");
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect((JSON.parse(run.stdout) as { ok: boolean }).ok).toBe(true);
  });
});

describe("the composite graph on the fixture (#2662)", () => {
  const compositesSchema = JSON.parse(readFileSync(join(workspaceSrc, "composites.schema.json"), "utf-8")) as object;

  test("graph --composites lists delivery's app, of kind DockerWebService, with the app component via member", () => {
    const run = chant(fixture, "workspace", "graph", "--composites", "--json");
    expect(run.status, run.stderr).toBe(0);
    const doc = JSON.parse(run.stdout) as {
      composites: { id: string; member: string; instance: string; kinds: string[]; lexicons: string[]; nodes: string[]; components: unknown[] }[];
      components: { id: string; archetype: string | null; composites: string[] | null; file: string | null; runtimes: unknown[]; environments: unknown[] }[];
      members: { name: string; runtimeReasons: unknown[]; environmentReasons: { code: string }[] }[];
      reasons: unknown[];
      summary: unknown;
    };
    const validate = compile2020(compositesSchema);
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(doc.composites).toEqual([
      {
        id: "delivery/app",
        member: "delivery",
        instance: "app",
        kinds: ["DockerWebService"],
        lexicons: ["docker"],
        nodes: ["delivery/appService"],
        components: [{ component: "delivery/app", by: "composites", against: "kind", value: "DockerWebService", label: "exact", via: "member" }],
      },
    ]);
    expect(doc.components).toEqual([
      {
        id: "delivery/app",
        name: "app",
        member: "delivery",
        archetype: "service",
        composites: ["DockerWebService"],
        file: "delivery/src/app.component.ts",
        // #2674: delivery configures no lexicon that hosts component runs, so the app deploys locally only.
        runtimes: [{ name: "local", lexicon: null, default: true, command: "chant run --components app" }],
        // #2695: delivery's config declares no environments and chant's own ledger holds no release of it, so local only.
        environments: [{ name: "local", default: true, source: "builtin", command: "chant run --components app" }],
      },
    ]);
    expect(doc.members.find((m) => m.name === "delivery")!.runtimeReasons).toEqual([]);
    expect(doc.members.find((m) => m.name === "delivery")!.environmentReasons.map((r) => r.code)).toEqual(["environments-none-declared"]);
    expect(doc.reasons).toEqual([]);
    expect(doc.summary).toEqual({ composites: 1, withComponent: 1, withoutComponent: 0, components: 1 });
  });
});

describe("work items (#2683)", () => {
  const workDir = join(fixture, "work");
  const files = readdirSync(workDir)
    .filter((f) => /^W-[0-9]{3,}-.+\.md$/.test(f))
    .sort();

  test("each validates against the work schema beside it", () => {
    expect(files).toEqual(["W-001-the-app-renders-the-home-screen-spec.md", "W-002-the-app-test-checks-the-home-page-against-the-spec.md"]);
    const mod = createRequire(join(repoRoot, "packages", "core", "package.json"))("ajv") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): Validate };
    const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(workDir, "work.schema.json"), "utf-8")) as object);
    for (const f of files) {
      const fm = parseFrontMatter(readFileSync(join(workDir, f), "utf-8"));
      if (!fm.ok) throw new Error(`${f}: ${fm.message}`);
      expect(validate(fm.value), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  test("records reads them: W-001 implements ref-002, and W-002 is blocked by W-001", async () => {
    const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: fixture });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.kind.name).toBe("work");
    expect(doc.summary).toEqual({ total: 2, valid: 2, invalid: 0, superseded: 0 });
    const [w1, w2] = doc.records;
    expect(w1).toMatchObject({ id: "W-001", state: "in-progress", ready: false, blockedBy: [], implements: [{ id: "ref-002", state: "decided" }], warnings: [] });
    expect(w2).toMatchObject({ id: "W-002", state: "open", ready: false, blockedBy: [{ id: "W-001", state: "in-progress" }], implements: [], warnings: [] });
    expect(doc.decisions!.map((d) => [d.id, d.implementedBy])).toEqual([
      ["ref-001", []],
      ["ref-002", [{ id: "W-001", state: "in-progress" }]],
    ]);
  });
});

describe("the intent graph on the fixture (#2651)", () => {
  const intentSchema = JSON.parse(readFileSync(join(workspaceSrc, "intent.schema.json"), "utf-8")) as object;

  test("graph --intent app/src/server.mjs:19 lists ref-001 and ref-002 by member, 72173388, and the findings #2651 names", () => {
    const run = chant(fixture, "workspace", "graph", "--intent", "app/src/server.mjs:19", "--kind", "decisions/decision.kind.mjs", "--json");
    expect(run.status, run.stderr).toBe(0);
    const doc = JSON.parse(run.stdout) as {
      region: string;
      history: { shallow: boolean };
      reasons: { code: string }[];
      nodes: { id: string; kind: string; code?: string; sha?: string; state?: string | null }[];
      edges: { kind: string; from: string; to: string; granularity?: string }[];
    };
    const validate = compile2020(intentSchema);
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(doc.region).toBe("region:app/src/server.mjs:19");

    const constrains = doc.edges.filter((e) => e.kind === "constrains" && e.to === doc.region).map((e) => [e.from, e.granularity]);
    expect(constrains).toEqual([
      ["record:decision/ref-001", "member"],
      ["record:decision/ref-002", "member"],
    ]);
    const touched = doc.edges.filter((e) => e.kind === "touched-by").map((e) => e.to);
    // A shallow clone (CI checks out one commit) cuts the history at its
    // boundary, and the document says so instead of naming 72173388.
    if (doc.history.shallow) expect(doc.reasons.map((r) => r.code)).toContain("intent-history-shallow");
    else expect(touched).toEqual([expect.stringMatching(/^commit:72173388/)]);

    const codes = doc.nodes.filter((n) => n.kind === "finding").map((n) => n.code);
    for (const code of ["intent-commit-undecided", "intent-constraint-coarse", "intent-decision-provisional"]) expect(codes).toContain(code);
    // Both decisions constrain the region by member only, so no commit falls in a path window (#2656).
    expect(doc.edges.filter((e) => e.kind === "within")).toEqual([]);
    for (const n of doc.nodes.filter((n) => n.kind === "commit")) expect(n.state).toBe("undecided");
    // Decisions reach artifacts, and ref-002 pins the screen spec.
    expect(doc.edges).toContainEqual({ kind: "pins", from: "record:decision/ref-002", to: "artifact:design/screens/home.json", pinnedSha256: expect.any(String), pinState: "pinned" });
  });

  test("graph --intent design/screens/home.json with the work kind shows W-001 and W-002, the implements edge and the needs edge (#2683)", () => {
    const run = chant(fixture, "workspace", "graph", "--intent", "design/screens/home.json", "--kind", "decisions/decision.kind.mjs", "--kind", "work/work.kind.mjs", "--json");
    expect(run.status, run.stderr).toBe(0);
    const doc = JSON.parse(run.stdout) as {
      region: string;
      nodes: { id: string; kind: string; code?: string; state?: string | null; ready?: boolean; blockedBy?: unknown[]; addressed?: boolean }[];
      edges: { kind: string; from: string; to: string; granularity?: string }[];
    };
    const validate = compile2020(intentSchema);
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const work = doc.nodes.filter((n) => n.kind === "work");
    expect(work.map((n) => [n.id, n.state, n.ready, n.blockedBy])).toEqual([
      ["record:work/W-001", "in-progress", false, []],
      ["record:work/W-002", "open", false, [{ id: "W-001", state: "in-progress" }]],
    ]);
    expect(doc.edges).toContainEqual({ kind: "constrains", from: "record:work/W-001", to: doc.region, granularity: "path", entry: "path:design/screens/home.json" });
    expect(doc.edges).toContainEqual({ kind: "implements", from: "record:work/W-001", to: "record:decision/ref-002" });
    expect(doc.edges).toContainEqual({ kind: "needs", from: "record:work/W-002", to: "record:work/W-001" });
    // ref-002 has a work item, so the gap W-001 came from no longer fires.
    // (The declared-kinds test below walks the same kinds without --kind.)
    const codes = doc.nodes.filter((n) => n.kind === "finding").map((n) => n.code);
    expect(codes).not.toContain("intent-decision-unimplemented");
    for (const f of doc.nodes.filter((n) => n.kind === "finding")) expect(typeof f.addressed).toBe("boolean");
  });

  test("graph --intent app/src/server.mjs with no --kind reads the declared kinds and shows the work nodes (#2680, #2683)", () => {
    const run = chant(fixture, "workspace", "graph", "--intent", "app/src/server.mjs", "--json");
    expect(run.status, run.stderr).toBe(0);
    const doc = JSON.parse(run.stdout) as {
      region: string;
      kinds: { file: string; records: string | null }[];
      nodes: { id: string; kind: string }[];
      edges: { kind: string; from: string; to: string; granularity?: string }[];
    };
    const validate = compile2020(intentSchema);
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(doc.kinds.map((k) => k.records)).toEqual(["decision", "work", "answer", "session"]);
    // W-001 constrains member:app. W-002 constrains paths outside this file and only needs W-001, so it stays out.
    expect(doc.nodes.filter((n) => n.kind === "work").map((n) => n.id)).toEqual(["record:work/W-001"]);
    expect(doc.edges).toContainEqual({ kind: "constrains", from: "record:work/W-001", to: doc.region, granularity: "member", entry: "member:app" });
    expect(doc.edges).toContainEqual({ kind: "implements", from: "record:work/W-001", to: "record:decision/ref-002" });
  });
});

describe("decision points on the work graph (#2741, ws-058)", () => {
  const on = "2026-09-25";
  const pointsText = () => readFileSync(join(fixture, "decisions", "points.json"), "utf-8");

  test("finding triage, needs a decision, slice tier and ship skip are declared, validate, and points lists them", () => {
    const points = parsePoints(pointsText(), "decisions/points.json");
    expect(Object.entries(points).map(([name, p]) => [name, p.question.type, p.deciders.map((d) => d.kind).join(">")])).toEqual([
      ["slice-tier", "choice", "table>model>quorum"],
      ["ship-skip", "noul", "table>quorum"],
      ["finding-triage", "choice", "table>model>quorum"],
      ["needs-a-decision", "noul", "table>model>quorum"],
    ]);
    expect(candidates(points["finding-triage"].question)).toEqual(["work-item", "needs-a-decision", "leave"]);
    // Every input names a read-contract output: the triage reads a finding and its region, the window its commits.
    expect(Object.keys(points["finding-triage"].inputs).map((i) => i.split(".")[0])).toEqual(["finding", "finding", "finding", "region", "region", "region"]);
    expect([...new Set(Object.keys(points["needs-a-decision"].inputs).map((i) => i.split(".")[0]))]).toEqual(["commit", "region", "work-item"]);

    const run = chant(fixture, "workspace", "points", "--json");
    expect(run.status, run.stderr).toBe(0);
    const doc = JSON.parse(run.stdout) as { points: { name: string }[]; sources: { reason: unknown }[] };
    expect(doc.points.map((p) => p.name)).toEqual(["slice-tier", "ship-skip", "finding-triage", "needs-a-decision"]);
    expect(doc.sources.map((s) => s.reason)).toEqual([null]);
  });

  test("ship skip, moved from chud: its table says no to every release, no model answers it, and its quorum is the gate's", async () => {
    const points = parsePoints(pointsText(), "decisions/points.json");
    expect(points["ship-skip"].deciders.some((d) => d.kind === "model")).toBe(false);
    expect(quorumOf(points["ship-skip"])).toEqual({ count: 1 });
    const inputs = {
      "release.first_release": false,
      "release.new_migrations": 0,
      "release.files_changed": 1,
      "release.app_changed": false,
      "release.work_changed": false,
      "release.units": 1,
    };
    const doc = await askPoint({ cwd: fixture, point: "ship-skip", inputs, subject: "release 1", on, dryRun: true });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.question).toMatchObject({ state: "answered", answer: false, decider: { kind: "table", row: 0 } });
    expect(doc.written).toBe(false);
  });

  test("needs a decision: a window whose commits are all a decision's own work needs none, and one with an undecided commit goes to people", async () => {
    const window = { "commit.count": 2, "commit.undecided": 0, "commit.decided_by_window": 0, "region.path": "app/src/server.mjs", "region.generated": false, "work-item.implements": 1 };
    const covered = await askPoint({ cwd: fixture, point: "needs-a-decision", inputs: window, subject: "W-001", on, dryRun: true });
    if ("error" in covered) throw new Error(`${covered.error.code}: ${covered.error.message}`);
    expect(covered.question).toMatchObject({ state: "answered", answer: false, decider: { kind: "table", row: 1 } });
    // With no model call, an undecided commit escalates past the table and the model to the quorum.
    const open = await askPoint({ cwd: fixture, point: "needs-a-decision", inputs: { ...window, "commit.undecided": 1 }, subject: "W-001", on, dryRun: true });
    if ("error" in open) throw new Error(`${open.error.code}: ${open.error.message}`);
    expect(open.question).toMatchObject({ state: "escalated", open: true, decider: { kind: "quorum", count: 1 } });
  });

  test("a finding produces a triage question, the stub decider's answer becomes a proposed work item, and a person keeps it", async () => {
    // 1. graph --intent reports the finding, on the fixture as committed. This read does
    // not depend on the scratch repo built below, so it runs concurrently with that setup
    // instead of serializing in front of it (chant #2777, ws-058).
    const graphPromise = chantAsync(fixture, "workspace", "graph", "--intent", "app/src/server.mjs", "--json");

    // The rest writes, so it runs on a copy of the fixture in its own repository.
    const scratch = mkdtempSync(join(tmpdir(), "chant-2741-triage-"));
    const root = join(scratch, "ws");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    const stub = await startStubBackend({
      answers: { "finding-triage": { type: "choice", choice: "work-item", probabilities: { "work-item": 0.9, "needs-a-decision": 0.06, leave: 0.04 }, confidence: 0.86 } },
    });
    try {
      cpSync(fixture, root, { recursive: true, filter: (src) => !/(^|\/)(node_modules|dist)(\/|$)/.test(src.slice(fixture.length)) });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-q", "-m", "the reference workspace");

      const graph = await graphPromise;
      expect(graph.status, graph.stderr).toBe(0);
      type Node = { id: string; kind: string; code?: string; message?: string; addressed?: boolean; addressedBy?: { id: string; state: string }[]; path?: string; member?: string; generated?: boolean };
      const nodesOf = (text: string) => (JSON.parse(text) as { region: string; nodes: Node[] });
      const g = nodesOf(graph.stdout);
      const region = g.nodes.find((n) => n.id === g.region)!;
      const finding = g.nodes.find((n) => n.kind === "finding" && n.code === "intent-constraint-coarse")!;
      expect(finding, "graph --intent app/src/server.mjs reports intent-constraint-coarse").toBeDefined();
      expect(finding.addressed).toBe(false);
      const inputs = {
        "finding.code": finding.code,
        "finding.message": finding.message,
        "finding.addressed": finding.addressed,
        "region.path": region.path,
        "region.member": region.member,
        "region.generated": region.generated,
      };

      // 2. The decide activity asks finding-triage. No table row matches, the stub decider answers
      //    work-item above the threshold, and the answer is a proposal: the run waits on it.
      const backends = { systemone: { url: stub.url } };
      const wait = await runDecide({ cwd: root, point: "finding-triage", inputs, subject: "app/src/server.mjs", backends }, { on }).then(
        (r) => {
          throw new Error(`expected the run to wait on a proposal, and decide returned ${JSON.stringify(r)}`);
        },
        (err: unknown) => {
          if (!isPointWait(err)) throw err;
          return err.question;
        },
      );
      expect(wait).toMatchObject({ point: "finding-triage", state: "proposed", subject: "app/src/server.mjs" });
      expect(stub.requests.map((r) => [r.model, Object.keys(r.questions)])).toEqual([["jev-1.13.0", ["finding-triage"]]]);

      // The read contract lists it as an open question with the model's answer, for hud to prompt a person.
      const listed = chant(root, "workspace", "points", "--open", "--json");
      expect(listed.status, listed.stderr).toBe(0);
      const open = (JSON.parse(listed.stdout) as { questions: { id: string; state: string; answer: unknown; confidence: number; decider: { kind: string; model?: string } }[] }).questions;
      // The fixture's own slice-tier proposal for W-002 is open too.
      expect(open.map((q) => [q.id, q.state, q.answer, q.decider.kind, q.decider.model, q.confidence])).toEqual([
        [wait.id, "proposed", "work-item", "model", "jev-1.13.0", 0.86],
        ["slice-tier-074b660bbaad", "proposed", "medium", "model", "bosun-v3.1-1.7b", 0.865],
      ]);

      // 3. The runtime writes the work item the answer proposes, naming the decider as its proposer.
      const fields = {
        schema: 1,
        title: "Constrain app/src/server.mjs by path",
        implements: [],
        needs: [],
        constrains: ["path:app/src/server.mjs"],
        evidence: [],
        opened_on: on,
        source: { finding: finding.code, region: region.path, answer: wait.id },
        supersedes: [],
      };
      writeFileSync(join(scratch, "work.json"), JSON.stringify({ ...fields, state: "proposed" }));
      const made = chant(root, "workspace", "records", "new", "work", "--from", join(scratch, "work.json"), "--by", "jev-1.13.0", "--json");
      expect(made.status, made.stderr + made.stdout).toBe(0);
      expect(JSON.parse(made.stdout)).toMatchObject({ id: "W-003" });
      const work = async () => {
        const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: root });
        if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
        return doc.records.find((r) => r.id === "W-003") as unknown as { state: string; valid: boolean; ready: boolean; data: Record<string, unknown> };
      };
      expect(await work()).toMatchObject({ state: "proposed", valid: true, ready: false, data: { proposed_by: "jev-1.13.0", source: { answer: wait.id } } });

      // 4. A person keeps it: confirms the triage answer, and moves the work item to open.
      const answered = chant(root, "workspace", "points", "answer", wait.id, "--answer", "work-item", "--by", "alice", "--json");
      expect(answered.status, answered.stderr + answered.stdout).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({ question: { state: "answered", answer: "work-item", answeredBy: ["alice"] } });
      writeFileSync(join(scratch, "keep.json"), JSON.stringify({ state: "open" }));
      const kept = chant(root, "workspace", "records", "amend", "W-003", "--kind", "work", "--set", join(scratch, "keep.json"), "--json");
      expect(kept.status, kept.stderr + kept.stdout).toBe(0);
      expect(await work()).toMatchObject({ state: "open", valid: true, ready: true, data: { proposed_by: "jev-1.13.0" } });

      // 5. Once committed, the finding reads as addressed by W-003, and asking the triage for it again, the table leaves it.
      git("add", "-A");
      git("commit", "-q", "-m", "W-003 kept");
      const after = chant(root, "workspace", "graph", "--intent", "app/src/server.mjs", "--json");
      expect(after.status, after.stderr).toBe(0);
      const again = nodesOf(after.stdout).nodes.find((n) => n.kind === "finding" && n.code === "intent-constraint-coarse")!;
      expect([again.addressed, again.addressedBy]).toEqual([true, [{ id: "W-003", state: "open" }]]);
      const left = await runDecide({ cwd: root, point: "finding-triage", inputs: { ...inputs, "finding.addressed": true }, subject: "app/src/server.mjs", backends }, { on });
      expect(left).toMatchObject({ state: "answered", answer: "leave", decider: "table" });
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
      rmSync(scratch, { recursive: true, force: true });
    }
    // Six chant CLI spawns (five of them serial by data dependency) plus two in-process
    // decide calls: on CI, each spawn cold-transforms the CLI's TypeScript from source (no
    // build step runs before `vitest run` there, and this repo ships no compiled CLI at
    // all, chant #2803), so the cost does not amortize across the six. Sharing a runner
    // with three other vitest shards, this case was seen past the suite's global 20s
    // default twice on 2026-09-25 (chant #2803, ws-058). #2784 gave it CLI_TIMEOUT_MS
    // (60s) as a stopgap; the read overlap above plus 35s here comfortably replace that
    // once #2803 lands, without carrying a 60s allowance for a case that no longer needs it.
  }, 35_000);
});

describe("chant init --from on the fixture", () => {
  // Reads the committed tree at HEAD, not the working tree, as any consumer would.
  test("copies it with a lineage lock, and the copy is a working workspace", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "chant-2543-init-")), "ws");
    try {
      const result = await initFromCommand({ from: `${repoRoot}@HEAD#reference-workspace`, path: target });
      expect(result.success, result.error).toBe(true);

      const lock = JSON.parse(readFileSync(join(target, ".chant", "workspace.lock.json"), "utf-8")) as {
        scopes: Record<string, { kind: string; source: { path?: string }; files: Record<string, { class: string }> }>;
      };
      const scope = lock.scopes["."];
      expect(scope.kind).toBe("template");
      expect(scope.source.path).toBe("reference-workspace");
      expect(Object.keys(scope.files)).toContain("delivery/src/app.ts");
      expect(existsSync(join(target, "chant.workspace.json"))).toBe(true);
      expect(existsSync(join(target, "chant.workspace.draft.json"))).toBe(false);
      // No --param: the declared default.
      expect((scope as { parameters?: unknown }).parameters).toEqual({ name: "Reference app" });
      expect(existsSync(join(target, "chant.template.json"))).toBe(false);

      const doc = await queryRecords({ kind: "decisions/decision.kind.mjs", current: true, cwd: target });
      if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
      expect(doc.summary.invalid).toBe(0);
      expect(doc.records.map((r) => r.id)).toContain("ref-001");
      // The work items come along, and read against the copy's decisions (#2683).
      const work = await queryRecords({ kind: "work/work.kind.mjs", cwd: target });
      if ("error" in work) throw new Error(`${work.error.code}: ${work.error.message}`);
      expect(work.records.map((r) => [r.id, r.valid, r.ready])).toEqual([
        ["W-001", true, false],
        ["W-002", true, false],
      ]);
      expect(Object.keys(scope.files)).toContain("work/W-001-the-app-renders-the-home-screen-spec.md");

      // The record-decisions skill and prompt come along too (#2709).
      expect(existsSync(join(target, "skills", "record-decisions", "SKILL.md"))).toBe(true);
      expect(existsSync(join(target, "docs", "record-decisions.md"))).toBe(true);
      expect(Object.keys(scope.files)).toContain("skills/record-decisions/SKILL.md");
      expect(Object.keys(scope.files)).toContain("docs/record-decisions.md");

      // The copy is a workspace of its own, outside any git repository.
      const ls = lsJson(target);
      expect(ls.workspace.name).toBe("reference");
      expect(ls.workspace.file).toBe("chant.workspace.json");
      expectTheFourMembers(ls.members);

      // The lock init wrote reads, with no open manual step.
      const check = chant(target, "workspace", "check", "--json");
      expect(check.status, check.stderr + check.stdout).toBe(0);
      expect((JSON.parse(check.stdout) as { ok: boolean; lock: string | null }).lock).not.toBeNull();
    } finally {
      rmSync(dirname(target), { recursive: true, force: true });
    }
  });

  // The directory form reads the working files, which match HEAD in a clean checkout.
  test("the directory form copies what the git form copies, with the digest alone as its address (#2647)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "chant-2647-init-"));
    try {
      const fromGit = await initFromCommand({ from: `${repoRoot}@HEAD#reference-workspace`, path: join(scratch, "git"), params: { name: "Untitled app" } });
      const fromDir = await initFromCommand({ from: `${repoRoot}#reference-workspace`, path: join(scratch, "dir"), params: { name: "Untitled app" } });
      expect(fromGit.success, fromGit.error).toBe(true);
      expect(fromDir.success, fromDir.error).toBe(true);
      expect(fromDir.createdFiles).toEqual(fromGit.createdFiles);
      for (const f of fromGit.createdFiles.filter((p) => p !== ".chant/workspace.lock.json")) {
        expect(readFileSync(join(scratch, "dir", f)).equals(readFileSync(join(scratch, "git", f))), f).toBe(true);
      }
      type Scope = { source: unknown; ref?: string; address: { digest: string }; parameters: unknown; files: unknown };
      const lockOf = (d: string) => (JSON.parse(readFileSync(join(scratch, d, ".chant", "workspace.lock.json"), "utf-8")) as { scopes: Record<string, Scope> }).scopes["."];
      const git = lockOf("git");
      const dir = lockOf("dir");
      expect(dir.parameters).toEqual({ name: "Untitled app" });
      expect(dir.parameters).toEqual(git.parameters);
      expect(dir.files).toEqual(git.files);
      expect(dir.address).toEqual({ digest: git.address.digest });
      expect(dir.source).toEqual({ type: "dir", path: repoRoot, member: "reference-workspace" });
      expect(dir.ref).toBeUndefined();

      const check = chant(join(scratch, "dir"), "workspace", "check", "--json");
      expect(check.status, check.stderr + check.stdout).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the manifest's listed files each carry the name placeholder", () => {
    const manifest = JSON.parse(readFileSync(join(fixture, "chant.template.json"), "utf-8")) as {
      parameters: Record<string, { type: string; default?: string }>;
      files: string[];
    };
    expect(Object.keys(manifest.parameters)).toEqual(["name"]);
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const f of manifest.files) expect(readFileSync(join(fixture, f), "utf-8"), f).toContain("{{chant:name}}");
  });

  test("--param name=<value> names the app, and the copy's app test passes with it", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "chant-2627-init-")), "ws");
    try {
      const refused = await initFromCommand({ from: `${repoRoot}@HEAD#reference-workspace`, path: target, params: { title: "x" } });
      expect(refused.error).toBe("unknown parameter title (declared: name)");
      expect(existsSync(target)).toBe(false);

      const result = await initFromCommand({ from: `${repoRoot}@HEAD#reference-workspace`, path: target, params: { name: "Untitled app" } });
      expect(result.success, result.error).toBe(true);
      const lock = JSON.parse(readFileSync(join(target, ".chant", "workspace.lock.json"), "utf-8")) as {
        scopes: Record<string, { parameters: Record<string, unknown> }>;
      };
      expect(lock.scopes["."].parameters).toEqual({ name: "Untitled app" });

      expect(readFileSync(join(target, "app", "src", "server.mjs"), "utf-8")).toContain('export const APP_NAME = "Untitled app";');
      const screen = JSON.parse(readFileSync(join(target, "design", "screens", "home.json"), "utf-8")) as { title: string };
      expect(screen.title).toBe("Untitled app");
      expect(readFileSync(join(target, "design", "screens", "home.svg"), "utf-8")).toContain(">Untitled app</text>");

      // ref-002 pinned the template's home.json; init re-pins it to the copy's bytes, so the pin holds (#2549).
      const records = await queryRecords({ kind: "decisions/decision.kind.mjs", current: true, cwd: target });
      if ("error" in records) throw new Error(`${records.error.code}: ${records.error.message}`);
      const ref002 = records.records.find((r) => r.id === "ref-002")!;
      expect(ref002.assets.map((a) => [a.path, a.state])).toEqual([["design/screens/home.json", "pinned"]]);
      expect(ref002.assets[0].sha256).toBe(createHash("sha256").update(readFileSync(join(target, "design", "screens", "home.json"))).digest("hex"));
      expect((lock.scopes["."] as { repinned?: unknown }).repinned).toEqual([
        { record: "decisions/ref-002-where-the-screen-design-lives.md", paths: ["design/screens/home.json"] },
      ]);

      const app = join(target, "app");
      const out = execFileSync(process.execPath, ["--test", join("test", "server.test.mjs")], { cwd: app, stdio: "pipe", encoding: "utf-8" });
      // execFileSync throws when a test fails.
      expect(out).toMatch(/fail 0/);
      const { handle } = (await import(join(app, "src", "server.mjs"))) as { handle: (req: unknown, res: unknown) => void };
      let body = "";
      handle({ method: "GET", url: "/" }, { writeHead: () => undefined, end: (b: string) => (body = b) });
      expect(body).toContain("<h1>Untitled app</h1>");
    } finally {
      rmSync(dirname(target), { recursive: true, force: true });
    }
  });
});
