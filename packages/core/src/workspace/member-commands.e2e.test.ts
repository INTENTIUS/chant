/**
 * `chant workspace build|lint|audit|graph` and the root refusal, end to end
 * through the real CLI (#2537).
 *
 * The fixture is a small workspace in a temporary git repository:
 *
 * - `platform`, the root member `.`, a chant project;
 * - `api` and `web` under `services/`, which share one toolchain: a
 *   `services/node_modules/.bin/chant` that logs each start and then runs this
 *   checkout's chant;
 * - `legacy`, whose own `node_modules/.bin/chant` plays a chant older than
 *   `workspace member-run` and the IR `version` field;
 * - `docs`, kind `other`, holding a stray `.ts` declaration the root project
 *   must not pick up once `docs` is a member;
 * - an `examples` group with one project.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REPO = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));
const LOADER = join(REPO, "node_modules", "tsx", "dist", "loader.mjs");
const MAIN = join(REPO, "packages", "core", "src", "cli", "main.ts");
const TIMEOUT = 240_000;

let root: string;
let services: string;
let legacyLog: string;

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  if (mode) chmodSync(join(root, path), mode);
}

const CONFIG = 'export default { lexicons: ["k8s"] };\n';
const ns = (exportName: string, name: string) =>
  `import { Namespace } from "@intentius/chant-lexicon-k8s";\nexport const ${exportName} = new Namespace({ metadata: { name: "${name}" } });\n`;

/** A chant from before member-run and the IR version field: it answers level-0 commands only. */
const OLD_CHANT = (log: string) => `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  workspace) echo "Error: Unknown command: workspace" >&2; exit 1 ;;
  graph) echo '{"nodes":[{"id":"Queue","kind":"Queue","lexicon":"old","attrs":{}}],"edges":[],"groups":{"byLexicon":{"old":["Queue"]}}}' ;;
  lint) echo '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"chant","rules":[]}},"results":[]}]}' ;;
  audit) echo "No auditable files found under .." ;;
  *) echo '{}' ;;
esac
`;

function chant(args: string[], cwd = root): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", `file://${LOADER}`, MAIN, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: TIMEOUT,
    env: { ...process.env, TSX_DISABLE_CACHE: "1", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf-8").trim().split("\n").filter(Boolean) : [];
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ws-members-")));
  services = join(root, "services.log");
  legacyLog = join(root, "legacy.log");
  write(
    "chant.workspace.json",
    JSON.stringify(
      {
        name: "acme",
        schema: 1,
        members: [
          { name: "platform", dir: ".", kind: "chant" },
          { name: "api", dir: "services/api", kind: "chant" },
          { name: "web", dir: "services/web", kind: "chant" },
          { name: "legacy", dir: "legacy", kind: "chant" },
          { name: "docs", dir: "docs", kind: "other", because: "prose and one stray script" },
          { name: "examples", kind: "examples", glob: "examples/*" },
        ],
      },
      null,
      2,
    ),
  );
  write("chant.config.ts", CONFIG);
  write("src/infra.ts", ns("rootNs", "root"));
  write("services/api/chant.config.ts", CONFIG);
  write("services/api/src/infra.ts", ns("apiNs", "api"));
  write(
    "services/api/manifests/pod.yaml",
    "apiVersion: v1\nkind: Pod\nmetadata:\n  name: bad\nspec:\n  containers:\n    - name: c\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n",
  );
  write("services/web/chant.config.ts", CONFIG);
  write("services/web/src/infra.ts", ns("webNs", "web"));
  write(
    "services/node_modules/.bin/chant",
    `#!/bin/sh\necho "$*" >> "${services}"\nexec "${process.execPath}" --import "file://${LOADER}" "${MAIN}" "$@"\n`,
    0o755,
  );
  write("legacy/chant.config.ts", CONFIG);
  write("legacy/node_modules/.bin/chant", OLD_CHANT(legacyLog), 0o755);
  write("docs/stray.ts", ns("strayNs", "docs-stray"));
  write("examples/demo/chant.config.ts", CONFIG);
  write("examples/demo/src/infra.ts", ns("demoNs", "demo"));
  write(".gitignore", "node_modules\n*.log\nout\n");
  mkdirSync(join(root, "node_modules", "@intentius"), { recursive: true });
  symlinkSync(join(REPO, "lexicons", "k8s"), join(root, "node_modules", "@intentius", "chant-lexicon-k8s"), "dir");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
}, TIMEOUT);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the root refusal (#2524 D0)", () => {
  test("build and lint at a declared root refuse with WSP000 and point to the workspace commands", () => {
    for (const verb of ["build", "lint"]) {
      const r = chant([verb]);
      expect(r.status, verb).toBe(1);
      expect(r.stderr, verb).toMatch(new RegExp(`WSP000: .*chant workspace ${verb}.*--root-only`));
    }
  }, TIMEOUT);

  test("--root-only builds the root project without the member directories", () => {
    const r = chant(["build", "--root-only"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("name: root");
    expect(r.stdout).not.toContain("docs-stray");
  }, TIMEOUT);

  test("a build inside a member is not refused", () => {
    const r = chant(["build", "."], join(root, "services", "api"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("name: api");
  }, TIMEOUT);
});

describe("chant workspace graph", () => {
  let doc: {
    version: number;
    members: Array<{ name: string; status: string; irVersion: number | null; chant: string | null; reason: { code: string } | null }>;
    nodes: Array<{ id: string; member: string }>;
    groups: { byMember: Record<string, string[]> };
  };

  beforeAll(() => {
    rmSync(services, { force: true });
    rmSync(legacyLog, { force: true });
    const r = chant(["workspace", "graph"]);
    expect(r.status, r.stderr).toBe(0);
    doc = JSON.parse(r.stdout);
  }, TIMEOUT);

  test("composes members with <member>/<id> ids and groups.byMember", () => {
    expect(doc.version).toBe(1);
    expect(doc.nodes.map((n) => n.id)).toEqual(["api/apiNs", "legacy/Queue", "platform/rootNs", "web/webNs"]);
    expect(doc.groups.byMember).toEqual({
      platform: ["platform/rootNs"],
      api: ["api/apiNs"],
      web: ["web/webNs"],
      legacy: ["legacy/Queue"],
    });
    expect(doc.members.find((m) => m.name === "docs")).toMatchObject({ status: "skipped", reason: { code: "kind-not-run" } });
  });

  test("upgrades an old chant's unversioned IR in place", () => {
    expect(doc.members.find((m) => m.name === "legacy")).toMatchObject({ status: "composed", irVersion: null, chant: null });
    expect(doc.members.find((m) => m.name === "api")).toMatchObject({ status: "composed", irVersion: 1 });
  });

  test("starts one process per toolchain identity, and one per member only for a chant without member-run", () => {
    expect(lines(services)).toEqual(["workspace member-run"]);
    expect(lines(legacyLog)).toEqual(["workspace member-run", "graph . --format ir"]);
  });

  test("leaves chant graph at the root as the single-project IR", () => {
    const r = chant(["graph", "--format", "ir"]);
    expect(r.status, r.stderr).toBe(0);
    const ir = JSON.parse(r.stdout) as { version: number; nodes: Array<{ id: string }>; groups: Record<string, unknown> };
    expect(ir.version).toBe(1);
    expect(ir.groups.byMember).toBeUndefined();
    expect(ir.nodes.every((n) => !n.id.includes("/"))).toBe(true);
  }, TIMEOUT);
});

describe("chant workspace lint, audit and build", () => {
  test("lint --format sarif writes one run per member and example project", () => {
    const r = chant(["workspace", "lint", "--format", "sarif"]);
    expect(r.status, r.stderr).toBe(0);
    const log = JSON.parse(r.stdout) as { runs: Array<{ automationDetails: { id: string }; results: Array<{ locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }> };
    expect(log.runs.map((run) => run.automationDetails.id)).toEqual(["platform/", "examples:examples/demo/", "api/", "web/", "legacy/"]);
    const uris = log.runs.flatMap((run) => run.results.map((res) => res.locations[0].physicalLocation.artifactLocation.uri));
    expect(uris).toContain("services/api/src/infra.ts");
    expect(uris.some((u) => u.startsWith("docs/"))).toBe(false);
  }, TIMEOUT);

  test("audit adds a member field, and member . leaves other members' files to them", () => {
    const r = chant(["workspace", "audit", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as { members: Array<{ member: string }>; findings: Array<{ member: string; file: string; checkId: string }> };
    expect(doc.members.map((m) => m.member)).toEqual(["platform", "api", "web", "legacy"]);
    const privileged = doc.findings.filter((f) => f.checkId === "WK8202");
    expect(privileged.map((f) => [f.member, f.file])).toEqual([["api", "manifests/pod.yaml"]]);
  }, TIMEOUT);

  test("build -o writes each member's output under its name", () => {
    const r = chant(["workspace", "build", "-o", "out"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/chant workspace build: 5 projects, 5 passed, 0 failed; 1 skipped; 3 toolchains/);
    expect(readFileSync(join(root, "out", "api.json"), "utf-8")).toContain("api");
    expect(existsSync(join(root, "out", "examples", "examples", "demo.json"))).toBe(true);
  }, TIMEOUT);
});
