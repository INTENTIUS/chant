/**
 * The reference workspace (#2543, #2524 D21) as chant's integration fixture.
 *
 * `reference-workspace/` is a workspace-shaped tree held at level 0: it has no
 * `chant.workspace.json` until the declaration lands (#2534), only a draft that
 * nothing reads. This file checks what exists of it today, against the commit
 * under test rather than a released chant:
 *
 * - the members the draft names are on disk, and no live declaration is;
 * - the app's own test passes;
 * - the delivery member builds and lints with no findings, and the Compose
 *   file it writes points at the app's Dockerfile;
 * - the decision files validate against chant's decision schema, and
 *   `chant workspace records` reads them through the fixture's own kind file,
 *   which must stay the same as chant's.
 *
 * - `chant init --from <this repo>@HEAD#reference-workspace` copies it with a
 *   lineage lock (#2540), and the copy reads its decisions on its own.
 *
 * The workspace commands and their contract tests join here as each phase
 * lands (#2537, #2536). The copy is not yet a working workspace in #2543's
 * sense: that needs the declaration (#2534).
 */

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { buildCommand } from "@intentius/chant/cli/commands/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { loadPlugins, resolveProjectLexicons } from "@intentius/chant/cli";
import { parseFrontMatter } from "@intentius/chant/workspace/records";
import { queryRecords } from "@intentius/chant/workspace/records-cli";
import { initFromCommand } from "@intentius/chant/workspace/lineage-init";

const repoRoot = resolve(import.meta.dirname, "..");
const fixture = join(repoRoot, "reference-workspace");
const chantDecisions = join(repoRoot, "docs", "design", "decisions");
const decisionsDir = join(fixture, "decisions");

interface DraftMember {
  name: string;
  dir: string;
  kind: string;
  roles?: string[];
  because?: string;
}

const draft = JSON.parse(readFileSync(join(fixture, "chant.workspace.draft.json"), "utf-8")) as {
  name: string;
  schema: number;
  members: DraftMember[];
};

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
  test("the draft declares the four members #2543 asks for", () => {
    expect(draft.schema).toBe(1);
    const byName = new Map(draft.members.map((m) => [m.name, m]));
    expect([...byName.keys()].sort()).toEqual(["app", "delivery", "design", "design-client"]);
    expect(byName.get("delivery")?.kind).toBe("chant");
    expect(byName.get("design-client")?.roles).toEqual(["design-app"]);
    for (const m of draft.members) {
      if (m.kind === "other") expect(m.because, `${m.name} is kind other with no because`).toBeTruthy();
    }
  });

  test("every member directory exists", () => {
    for (const m of draft.members) {
      expect(existsSync(join(fixture, m.dir)), `${m.dir} is missing`).toBe(true);
    }
  });

  test("it stays at level 0: no live declaration anywhere in it", () => {
    const declarations = walk(fixture).filter((p) => /(^|\/)chant\.workspace\.jsonc?$/.test(p));
    expect(declarations).toEqual([]);
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
      const build = compose.services.app?.build;
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
          draft.members.map((m) => m.name),
          `${f} constrains ${c}, which the draft does not declare`,
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
});

describe("chant init --from on the fixture", () => {
  // Reads the committed tree at HEAD, not the working tree, as any consumer would.
  test("copies it with a lineage lock, and the copy reads its own decisions", async () => {
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
      expect(existsSync(join(target, "chant.workspace.draft.json"))).toBe(true);

      const doc = await queryRecords({ kind: "decisions/decision.kind.mjs", current: true, cwd: target });
      if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
      expect(doc.summary.invalid).toBe(0);
      expect(doc.records.map((r) => r.id)).toContain("ref-001");
    } finally {
      rmSync(dirname(target), { recursive: true, force: true });
    }
  });
});
