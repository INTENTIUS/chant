import { describe, test, expect } from "vitest";
import { auditFiles, type AuditInput } from "./core";
import type { PostSynthCheck } from "../lint/post-synth";

const DIRTY_GH = `name: CI
on:
  push:
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: acme/deploy-action@v1
      - run: npm ci
`;

const CLEAN_GH = `name: CI
on:
  push:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - run: npm ci
`;

const DIRTY_GL = `variables:
  DB_PASSWORD: "s3cr3t-hunter2-password-value"
build:
  stage: build
  script:
    - echo hi
`;

const DIRTY_FJ = `name: CI
on:
  push:
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo hi
`;

describe("auditFiles", () => {
  test("flags unpinned action and write-all permissions in a github workflow", async () => {
    const inputs: AuditInput[] = [
      { path: ".github/workflows/ci.yml", content: DIRTY_GH, lexicon: "github" },
    ];
    const findings = await auditFiles(inputs);
    const ids = new Set(findings.map((f) => f.checkId));

    expect(ids).toContain("GHA033"); // write-all permissions
    expect(ids).toContain("GHA021"); // unpinned actions/checkout
    expect(ids).toContain("GHA029"); // unpinned action reference
    // Findings are tagged to the source file.
    expect(findings.every((f) => f.file === ".github/workflows/ci.yml")).toBe(true);
  });

  test("a hardened github workflow has no permission/pinning security findings", async () => {
    const findings = await auditFiles([
      { path: ".github/workflows/ci.yml", content: CLEAN_GH, lexicon: "github" },
    ]);
    const ids = new Set(findings.map((f) => f.checkId));
    expect(ids.has("GHA033")).toBe(false);
    expect(ids.has("GHA021")).toBe(false);
    expect(ids.has("GHA029")).toBe(false);
  });

  test("flags a hardcoded secret in a gitlab pipeline", async () => {
    const findings = await auditFiles([
      { path: ".gitlab-ci.yml", content: DIRTY_GL, lexicon: "gitlab" },
    ]);
    const ids = new Set(findings.map((f) => f.checkId));
    expect(ids).toContain("WGL016");
  });

  test("runs github-tier security checks on forgejo (github-dialect) workflows", async () => {
    const findings = await auditFiles([
      { path: ".forgejo/workflows/ci.yml", content: DIRTY_FJ, lexicon: "forgejo" },
    ]);
    const ids = new Set(findings.map((f) => f.checkId));
    // Forgejo workflows are GitHub-syntax, so the GHA security tier applies.
    expect(ids).toContain("GHA033");
    expect(ids).toContain("GHA021");
  });

  test("uses an injected checks provider and tags findings per file", async () => {
    const fake: PostSynthCheck = {
      id: "FAKE001",
      description: "fake",
      check: () => [{ checkId: "FAKE001", severity: "warning", message: "hit" }],
    };
    const findings = await auditFiles(
      [
        { path: "a.yml", content: "x", lexicon: "github" },
        { path: "b.yml", content: "y", lexicon: "github" },
      ],
      { checksProvider: async () => [fake] },
    );
    expect(findings.map((f) => f.file).sort()).toEqual(["a.yml", "b.yml"]);
  });

  test("a check that throws does not abort the audit", async () => {
    const boom: PostSynthCheck = {
      id: "BOOM",
      description: "throws",
      check: () => {
        throw new Error("bad yaml");
      },
    };
    const ok: PostSynthCheck = {
      id: "OK001",
      description: "ok",
      check: () => [{ checkId: "OK001", severity: "info", message: "ok" }],
    };
    const findings = await auditFiles([{ path: "a.yml", content: "x", lexicon: "github" }], {
      checksProvider: async () => [boom, ok],
    });
    expect(findings.map((f) => f.checkId)).toEqual(["OK001"]);
  });
});
