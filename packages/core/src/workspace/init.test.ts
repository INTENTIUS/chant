import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/main";
import { parseDeclaration } from "./declaration";
import { proposeWorkspace, runWorkspaceInit, sanitizeName } from "./init";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>, remote?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-init-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  return root;
}

const pkg = (name: string, deps: Record<string, string> = {}) => JSON.stringify({ name, dependencies: deps });

const ACME = {
  "package.json": JSON.stringify({ name: "acme-monorepo", workspaces: ["packages/*"] }),
  "packages/sdk/package.json": pkg("@acme/acme-sdk"),
  "packages/sdk/src/index.ts": "",
  "packages/sdk/src/__fixtures__/proj/chant.config.ts": "",
  "packages/sdk/test/fixtures/p1/chant.config.ts": "",
  "apps/web/package.json": pkg("@acme/web", { "@intentius/chant": "*" }),
  "apps/web/chant.config.ts": "",
  "apps/web/src/main.ts": "",
  "apps/web/src/sub/chant.config.json": "{}",
  "infra/chant.config.ts": "",
  "infra/stack.ts": "",
  "infra/stack.test.ts": "",
  "examples/a/chant.config.ts": "",
  "examples/a/main.ts": "",
  "examples/b/src/chant.config.json": "{}",
  "examples/c/package.json": pkg("c", { "@intentius/chant-lexicon-aws": "*" }),
  "examples/notes/README.md": "",
  "tools/docs/package.json": pkg("docs-site"),
  "vendor/kit/chant.workspace.json": JSON.stringify({ name: "kit", schema: 1, members: [] }),
  "vendor/kit/app/chant.config.ts": "",
  "node_modules/dep/chant.config.ts": "",
  "test/e2e/proj/chant.config.ts": "",
  "test/unit/x.ts": "",
  "test/unit2/x.ts": "",
  "test/unit3/x.ts": "",
};

describe("proposeWorkspace (#2534)", () => {
  test("proposes members from projects, nested workspaces and packages, and example groups (ws-051)", () => {
    const root = repo(ACME, "git@github.com:acme/platform.git");
    const { declaration } = proposeWorkspace(root);
    expect(declaration.name).toBe("platform");
    expect(declaration.members).toEqual([
      { name: "web", dir: "apps/web", kind: "chant" },
      { name: "infra", dir: "infra", kind: "chant" },
      { name: "acme-sdk", dir: "packages/sdk", kind: "other", because: "an npm workspace package with no chant project" },
      { name: "docs-site", dir: "tools/docs", kind: "other", because: "an npm package with no chant project" },
      { name: "kit", dir: "vendor/kit", kind: "workspace" },
      { name: "examples", kind: "examples", glob: "examples/*" },
      { name: "packages-sdk-fixtures", kind: "examples", glob: "packages/sdk/test/fixtures/*" },
      { name: "fixtures", kind: "examples", glob: "test/e2e" },
    ]);
    // The proposal reads back as a valid declaration.
    expect(() => parseDeclaration(JSON.stringify(declaration), "chant.workspace.json")).not.toThrow();
  });

  test("names the workspace by --name, then the remote, then the root package, then the directory", () => {
    expect(proposeWorkspace(repo(ACME, "https://example.com/org/Platform.git"), { name: "given" }).declaration.name).toBe("given");
    expect(proposeWorkspace(repo(ACME)).declaration.name).toBe("acme-monorepo");
  });

  test("a root with its own chant config becomes the root member", () => {
    const root = repo({ "chant.config.ts": "", "src/a.ts": "", "services/api/chant.config.ts": "" });
    expect(proposeWorkspace(root, { name: "x" }).declaration.members).toEqual([
      { name: "root", dir: ".", kind: "chant" },
      { name: "api", dir: "services/api", kind: "chant" },
    ]);
  });

  test("reports the directories leaving the root project with their .ts source files", () => {
    const root = repo(ACME);
    const { leaving } = proposeWorkspace(root, { name: "acme" });
    expect(leaving.map((l) => [l.dir, l.owner])).toEqual([
      ["apps/web", "web"],
      ["examples/a", "examples"],
      ["examples/b", "examples"],
      ["examples/c", "examples"],
      ["infra", "infra"],
      ["packages/sdk", "sdk"],
      ["test/e2e", "fixtures"],
      ["tools/docs", "docs-site"],
      ["vendor/kit", "kit"],
    ]);
    // Tests are not source; the config is, as the root build's walker reads it.
    expect(leaving.find((l) => l.dir === "infra")?.files).toEqual(["infra/chant.config.ts", "infra/stack.ts"]);
    expect(leaving.find((l) => l.dir === "apps/web")?.files).toEqual(["apps/web/chant.config.ts", "apps/web/src/main.ts"]);
  });

  test("proposes one distinct ownership stack per chant member, and never touches a config (#2538, ws-037)", () => {
    const files = {
      "chant.config.ts": `export default { lexicons: ["k8s"], ownership: { stack: "shop", env: "prod" } };`,
      "services/api/chant.config.ts": `export default {\n  ownership: {\n    stack: 'api',\n  },\n};`,
      "services/web/chant.config.json": JSON.stringify({ ownership: { stack: "shop" } }),
      "services/jobs/chant.config.ts": `export default { lexicons: ["aws"] };`,
      "services/cron/chant.config.ts": "const s = process.env.STACK;\nexport default { ownership: { stack: s } };",
      "services/shop/chant.config.ts": `export default { lexicons: ["aws"] };`,
    };
    const root = repo(files);
    const { stacks, declaration } = proposeWorkspace(root, { name: "acme" });
    expect(stacks.map((s) => [s.member, s.current, s.proposed, s.reason ?? "keep"])).toEqual([
      ["root", "shop", "shop", "keep"],
      ["api", "api", "api", "keep"],
      ["cron", null, "cron", "computed"],
      ["jobs", null, "jobs", "missing"],
      // "shop" is taken by the root member, so the member named shop gets a number.
      ["shop", null, "shop-2", "missing"],
      ["web", "shop", "web", "shared"],
    ]);
    expect(new Set(stacks.map((s) => s.proposed)).size).toBe(stacks.length);
    expect(stacks.find((s) => s.member === "web")?.config).toBe("services/web/chant.config.json");
    // No marker key, and nothing about stacks, goes into the declaration.
    expect(JSON.stringify(declaration)).not.toMatch(/stack/);
    for (const [path, text] of Object.entries(files)) expect(readFileSync(join(root, path), "utf-8")).toBe(text);
  });

  test("sanitizeName fits the member grammar", () => {
    expect(sanitizeName("@Acme/My_Pkg.v2")).toBe("acme-my-pkg-v2");
    expect(sanitizeName("--x--")).toBe("x");
    expect(sanitizeName("a".repeat(50))).toHaveLength(40);
  });

  test("on the chant repo it proposes the packages, lexicons and example groups the repo commits (#2557)", () => {
    const { declaration, leaving } = proposeWorkspace(REPO);
    const committed = JSON.parse(readFileSync(join(REPO, "chant.workspace.json"), "utf-8")) as typeof declaration;
    expect(declaration.name).toBe("chant");
    // The committed file may differ by hand elsewhere (the reference workspace
    // is one member there), but packages, lexicons and groups are init's.
    const shape = (d: typeof declaration) =>
      d.members
        .filter((m) => m.kind === "examples" || /^(packages|lexicons)\//.test(m.dir ?? ""))
        .map((m) => [m.name, m.dir ?? null, m.kind, m.glob ?? null]);
    expect(shape(declaration)).toEqual(shape(committed));
    // Lexicon examples inside a lexicon's directory leave with that lexicon.
    expect(leaving.some((l) => l.dir.startsWith("lexicons/aws/examples/"))).toBe(false);
    expect(leaving.find((l) => l.dir === "lexicons/aws")?.owner).toBe("lexicon-aws");
  });
});

describe("chant workspace init (#2534)", () => {
  let out: string[];
  let err: string[];
  const tty = process.stdin.isTTY;
  const setTty = (value: boolean | undefined) => Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  beforeEach(() => {
    out = [];
    err = [];
    // No terminal: init must not wait for an answer.
    setTty(false);
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setTty(tty);
  });

  const run = (...argv: string[]) => runWorkspaceInit({ args: parseArgs(["workspace", "init", ...argv]), plugins: [] } as never);

  test("prints the proposal and what leaves the root project, and writes nothing without confirmation", async () => {
    const root = repo(ACME);
    expect(await run(root)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/"kind": "examples"/);
    expect(text).toMatch(/these directories leave the root project/);
    expect(text).toMatch(/infra\s+infra\s+2/);
    expect(text).toMatch(/Nothing written\. Re-run with --yes/);
    expect(existsSync(join(root, "chant.workspace.json"))).toBe(false);
    expect(text.indexOf("leave the root project")).toBeLessThan(text.indexOf("Nothing written"));
  });

  test("--yes writes the proposal, and a second init refuses to overwrite it", async () => {
    const root = repo(ACME);
    expect(await run(root, "--yes", "--name", "acme")).toBe(0);
    const written = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8"));
    expect(written).toMatchObject({ name: "acme", schema: 1 });
    expect(await run(root, "--yes")).toBe(1);
    expect(err.join("\n")).toMatch(/already exists/);
  });

  test("prints the stack each chant member should use", async () => {
    const root = repo({
      "services/api/chant.config.json": JSON.stringify({ ownership: { stack: "shop" } }),
      "services/web/chant.config.json": JSON.stringify({ ownership: { stack: "shop" } }),
    });
    expect(await run(root, "--name", "acme")).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/Each chant member needs its own ownership\.stack/);
    expect(text).toMatch(/api\s+shop\s+keep/);
    expect(text).toMatch(/web\s+web\s+rename from "shop" in services\/web\/chant\.config\.json/);
  });

  test("--verbose lists every file leaving the root project", async () => {
    const root = repo(ACME);
    expect(await run(root, "--verbose")).toBe(0);
    expect(out.join("\n")).toMatch(/\n\s+infra\/stack\.ts/);
  });

  test("an invalid --name is refused", async () => {
    expect(await run(repo(ACME), "--name", "Not Valid")).toBe(1);
    expect(err.join("\n")).toMatch(/not a valid workspace name/);
  });
});
