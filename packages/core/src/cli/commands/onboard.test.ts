import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  onboardCommand,
  patchDockerfile,
  patchRootTsconfigPaths,
  insertPrepackAfterEach,
} from "./onboard";

function makeTempDir(): string {
  const dir = join(tmpdir(), `chant-onboard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const rootPackageJson = {
  workspaces: ["packages/*", "lexicons/*"],
  dependencies: {
    "@intentius/chant-lexicon-aws": "workspace:*",
    "@intentius/chant-lexicon-k8s": "workspace:*",
  },
};

const rootTsconfig = {
  compilerOptions: {
    moduleResolution: "node",
    baseUrl: ".",
    paths: {
      "@intentius/chant": ["packages/core/src/index.ts"],
      "@intentius/chant/*": ["packages/core/src/*"],
      "@intentius/chant-lexicon-aws": ["lexicons/aws/src/index.ts"],
      "@intentius/chant-lexicon-aws/*": ["lexicons/aws/src/*"],
    },
  },
  include: ["packages/core/src/**/*.ts", "lexicons/*/src/**/*.ts", "lexicons/*/examples/*/src/**/*.ts"],
};

const ciContent = `name: chant
on: [push]
jobs:
  check:
    steps:
      - name: Generate lexicon artifacts
        run: |
          npm run --prefix lexicons/aws prepack
          npm run --prefix lexicons/gitlab prepack
          npm run --prefix lexicons/k8s prepack
      - name: Run tests
        run: npx vitest run

  test:
    steps:
      - name: Generate lexicon artifacts
        run: |
          npm run --prefix lexicons/aws prepack
          npm run --prefix lexicons/gitlab prepack
          npm run --prefix lexicons/k8s prepack
      - name: Run tests
        run: npx vitest run

  validate:
    steps:
      - name: Generate and validate AWS lexicon
        run: npm run --prefix lexicons/aws prepack

      - name: Generate and validate GitLab lexicon
        run: npm run --prefix lexicons/gitlab prepack

      - name: Generate and validate K8s lexicon
        run: npm run --prefix lexicons/k8s prepack
`;

const publishContent = `name: publish
on:
  push:
    tags: ['v*']
jobs:
  test:
    # 12 lexicon prepacks (build + validate) plus the full vitest suite
    steps:
      - run: npm run --prefix lexicons/aws prepack
      - run: npm run --prefix lexicons/gitlab prepack
      - run: npm run --prefix lexicons/k8s prepack
      - run: npx vitest run
`;

// Mirrors test/Dockerfile.smoke on main: a loop, a comment and an echo that
// all contain the placeholder substring the old matcher anchored on (#1678).
const dockerLoopContent = `FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm install
# Run: just prepack  (or npm run --prefix lexicons/<lex> prepack) before building this Dockerfile.
RUN for lex in aws azure gcp gitlab k8s docker cedar; do \\
      if [ ! -d "lexicons/$lex/dist" ]; then \\
        echo "ERROR: lexicons/$lex/dist/ not found. Run codegen first: npm run --prefix lexicons/$lex prepack" >&2; \\
        exit 1; \\
      fi; \\
    done
COPY test/integration.sh /app/test/integration.sh
`;

// Mirrors test/Dockerfile.smoke-npm: two loops, no prepack invocation at all.
const dockerNpmContent = `FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN CORE_VERSION=$(jq -r '.version' packages/core/package.json) && \\
    for lex in aws azure gcp gitlab k8s docker fly fountain; do \\
      cd /app/lexicons/$lex && jq 'del(.scripts)' package.json > tmp.json && mv tmp.json package.json; \\
    done

#   smoke.sh ran prepack locally; COPY . . already brought dist/ into this stage.
RUN mkdir -p /tarballs && \\
    for lex in aws azure gcp gitlab k8s docker fly fountain; do \\
      tar czf /tarballs/lexicon-\${lex}.tgz -C /app/lexicons/$lex ./package.json ./src ./dist || exit 1; \\
    done
`;

const dockerPerLineContent = `FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm install
RUN npm run --prefix lexicons/aws prepack
RUN npm run --prefix lexicons/gitlab prepack
RUN npm run --prefix lexicons/k8s prepack
COPY test/integration.sh /app/test/integration.sh
`;

function writeFixtureRepo(root: string): void {
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(rootPackageJson, null, 2) + "\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify(rootTsconfig, null, 2) + "\n");
  writeFileSync(join(root, ".github/workflows/chant.yml"), ciContent);
  writeFileSync(join(root, ".github/workflows/publish.yml"), publishContent);
  writeFileSync(join(root, "test/Dockerfile.smoke"), dockerLoopContent);
  writeFileSync(join(root, "test/Dockerfile.smoke-npm"), dockerNpmContent);
}

const TRACKED = [
  "package.json",
  "tsconfig.json",
  ".github/workflows/chant.yml",
  ".github/workflows/publish.yml",
  "test/Dockerfile.smoke",
  "test/Dockerfile.smoke-npm",
];

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of TRACKED) out[f] = readFileSync(join(root, f), "utf-8");
  return out;
}

describe("onboardCommand", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    writeFixtureRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("first run patches every file once", () => {
    const result = onboardCommand({ name: "terraform", root });
    expect(result.success).toBe(true);
    expect(result.patched).toEqual([
      "package.json (root dependency)",
      "tsconfig.json (paths mapping)",
      "chant.yml (prepack + validate)",
      "publish.yml (prepack)",
      "Dockerfile.smoke (lexicon list)",
      "Dockerfile.smoke-npm (lexicon list)",
    ]);
    expect(result.skipped).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.dependencies["@intentius/chant-lexicon-terraform"]).toBe("workspace:*");

    const ci = readFileSync(join(root, ".github/workflows/chant.yml"), "utf-8");
    expect(ci.match(/lexicons\/terraform prepack/g)?.length).toBe(3); // check + test + validate
    expect(ci).toContain("Generate and validate Terraform lexicon");

    const pub = readFileSync(join(root, ".github/workflows/publish.yml"), "utf-8");
    expect(pub.match(/lexicons\/terraform prepack/g)?.length).toBe(1);
    expect(pub).toContain("      - run: npm run --prefix lexicons/terraform prepack\n      - run: npx vitest run");
  });

  test("second run is a byte-identical no-op and reports already covered (#1678)", () => {
    onboardCommand({ name: "terraform", root });
    const after1 = snapshot(root);

    const result = onboardCommand({ name: "terraform", root });
    const after2 = snapshot(root);

    expect(after2).toEqual(after1);
    expect(result.patched).toEqual([]);
    expect(result.skipped).toEqual([
      "package.json: @intentius/chant-lexicon-terraform already in dependencies",
      "tsconfig.json: @intentius/chant-lexicon-terraform already in paths",
      "chant.yml: terraform already in chant.yml",
      "publish.yml: prepack for terraform already present",
      "Dockerfile.smoke: already covers terraform",
      "Dockerfile.smoke-npm: already covers terraform",
    ]);
  });

  test("running onboard three times leaves exactly one copy of everything", () => {
    for (let i = 0; i < 3; i++) onboardCommand({ name: "terraform", root });
    const ci = readFileSync(join(root, ".github/workflows/chant.yml"), "utf-8");
    expect(ci.match(/lexicons\/terraform prepack/g)?.length).toBe(3);
    const docker = readFileSync(join(root, "test/Dockerfile.smoke"), "utf-8");
    expect(docker.match(/terraform/g)?.length).toBe(1);
  });
});

describe("root tsconfig.json paths (#1614)", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    writeFixtureRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("adds bare and subpath mappings", () => {
    const result = patchRootTsconfigPaths(root, "terraform");
    expect(result.patched).toBe(true);

    const cfg = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf-8"));
    expect(cfg.compilerOptions.paths["@intentius/chant-lexicon-terraform"]).toEqual([
      "lexicons/terraform/src/index.ts",
    ]);
    expect(cfg.compilerOptions.paths["@intentius/chant-lexicon-terraform/*"]).toEqual(["lexicons/terraform/src/*"]);
    // Existing entries untouched
    expect(cfg.compilerOptions.paths["@intentius/chant-lexicon-aws"]).toEqual(["lexicons/aws/src/index.ts"]);
    expect(cfg.compilerOptions.moduleResolution).toBe("node");
  });

  test("is idempotent", () => {
    patchRootTsconfigPaths(root, "terraform");
    const before = readFileSync(join(root, "tsconfig.json"), "utf-8");
    const result = patchRootTsconfigPaths(root, "terraform");
    expect(result.patched).toBe(false);
    expect(result.reason).toContain("already in paths");
    expect(readFileSync(join(root, "tsconfig.json"), "utf-8")).toBe(before);
  });

  test("skips an already-present lexicon", () => {
    const result = patchRootTsconfigPaths(root, "aws");
    expect(result.patched).toBe(false);
  });

  test("creates the paths map when missing", () => {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }) + "\n");
    const result = patchRootTsconfigPaths(root, "terraform");
    expect(result.patched).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf-8"));
    expect(Object.keys(cfg.compilerOptions.paths)).toEqual([
      "@intentius/chant-lexicon-terraform",
      "@intentius/chant-lexicon-terraform/*",
    ]);
  });
});

describe("Dockerfile patching (#1678)", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    mkdirSync(join(root, "test"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("loop-based Dockerfile.smoke gains exactly one list entry", () => {
    const file = join(root, "test/Dockerfile.smoke");
    writeFileSync(file, dockerLoopContent);

    const result = patchDockerfile(file, "terraform");
    expect(result.patched).toBe(true);

    const out = readFileSync(file, "utf-8");
    expect(out).toContain("RUN for lex in aws azure gcp gitlab k8s docker cedar terraform; do \\");
    // No RUN line was appended after the comment or the echo
    expect(out).not.toContain("RUN npm run --prefix lexicons/terraform prepack");
    expect(out.match(/terraform/g)?.length).toBe(1);
    // Everything else is untouched
    expect(out.split("\n").length).toBe(dockerLoopContent.split("\n").length);
  });

  test("loop-based file already covering the lexicon is a no-op", () => {
    const file = join(root, "test/Dockerfile.smoke");
    writeFileSync(file, dockerLoopContent);

    const result = patchDockerfile(file, "cedar");
    expect(result.patched).toBe(false);
    expect(result.reason).toBe("already covers cedar");
    expect(readFileSync(file, "utf-8")).toBe(dockerLoopContent);
  });

  test("second patch of a loop-based file is byte-identical", () => {
    const file = join(root, "test/Dockerfile.smoke");
    writeFileSync(file, dockerLoopContent);

    patchDockerfile(file, "terraform");
    const once = readFileSync(file, "utf-8");
    const result = patchDockerfile(file, "terraform");
    expect(result.patched).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe(once);
  });

  test("Dockerfile.smoke-npm adds the name to both loops and nothing else", () => {
    const file = join(root, "test/Dockerfile.smoke-npm");
    writeFileSync(file, dockerNpmContent);

    const result = patchDockerfile(file, "terraform");
    expect(result.patched).toBe(true);

    const out = readFileSync(file, "utf-8");
    expect(out.match(/for lex in aws azure gcp gitlab k8s docker fly fountain terraform; do/g)?.length).toBe(2);
    expect(out.match(/terraform/g)?.length).toBe(2);
    expect(out.split("\n").length).toBe(dockerNpmContent.split("\n").length);

    // Reported as a no-op the second time, not as patched
    expect(patchDockerfile(file, "terraform")).toEqual({ patched: false, reason: "already covers terraform" });
    expect(readFileSync(file, "utf-8")).toBe(out);
  });

  test("per-lexicon RUN layout still gets a new RUN line after the last one", () => {
    const file = join(root, "test/Dockerfile.smoke");
    writeFileSync(file, dockerPerLineContent);

    const result = patchDockerfile(file, "terraform");
    expect(result.patched).toBe(true);

    const out = readFileSync(file, "utf-8");
    expect(out).toContain("RUN npm run --prefix lexicons/k8s prepack\nRUN npm run --prefix lexicons/terraform prepack\n");
    expect(out.match(/lexicons\/terraform prepack/g)?.length).toBe(1);

    expect(patchDockerfile(file, "terraform").patched).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe(out);
  });

  test("a file with nothing to anchor on is reported, not silently 'patched'", () => {
    const file = join(root, "test/Dockerfile.smoke-npm");
    const content = "FROM node:22-slim\nCOPY . .\n";
    writeFileSync(file, content);

    const result = patchDockerfile(file, "terraform");
    expect(result.patched).toBe(false);
    expect(result.reason).toContain("anchor");
    expect(readFileSync(file, "utf-8")).toBe(content);
  });
});

describe("insertPrepackAfterEach", () => {
  test("ignores comments and echo lines that mention prepack", () => {
    const lines = dockerLoopContent.split("\n");
    const before = [...lines];
    expect(insertPrepackAfterEach(lines, "terraform")).toBe(false);
    expect(lines).toEqual(before);
  });

  test("anchors on real RUN lines only", () => {
    const lines = [
      "# npm run --prefix lexicons/<lex> prepack",
      "RUN npm run --prefix lexicons/aws prepack",
      'RUN echo "npm run --prefix lexicons/$lex prepack"',
    ];
    expect(insertPrepackAfterEach(lines, "terraform")).toBe(true);
    expect(lines).toEqual([
      "# npm run --prefix lexicons/<lex> prepack",
      "RUN npm run --prefix lexicons/aws prepack",
      "RUN npm run --prefix lexicons/terraform prepack",
      'RUN echo "npm run --prefix lexicons/$lex prepack"',
    ]);
  });
});
