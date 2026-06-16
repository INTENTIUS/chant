import { describe, test, expect } from "vitest";
import { proveFix, unifiedDiff, extractUnpinnedImages } from "./proof";

const WF = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
`;

const WF_WRITE_ALL = `name: CI
on:
  push:
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
`;

describe("proveFix — pin action (GHA021/GHA029)", () => {
  test("pins an unpinned action and the diff shows only that line", () => {
    const sha = "11bd71901bbe5b1630ceea73d27597364c9af683";
    const res = proveFix("GHA021", WF, { resolveSha: () => sha });
    expect(res.applied).toBe(true);
    expect(res.patched).toContain(`actions/checkout@${sha}  # v4`);
    // Only the uses line changes: exactly one - and one + in the diff.
    const removed = res.diff!.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = res.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(removed).toEqual(["-      - uses: actions/checkout@v4"]);
    expect(added).toEqual([`+      - uses: actions/checkout@${sha}  # v4`]);
  });

  test("needs a sha when none can be resolved", () => {
    const res = proveFix("GHA021", WF, { resolveSha: () => undefined });
    expect(res.applied).toBe(false);
    expect(res.note).toMatch(/SHA is required/i);
  });

  test("no-op when the action is already pinned", () => {
    const pinned = WF.replace("@v4", "@11bd71901bbe5b1630ceea73d27597364c9af683");
    const res = proveFix("GHA021", pinned, { resolveSha: () => "x" });
    expect(res.applied).toBe(false);
    expect(res.note).toMatch(/no-op/i);
  });
});

describe("proveFix — permissions", () => {
  test("adds a least-privilege block additively (GHA017)", () => {
    const res = proveFix("GHA017", WF);
    expect(res.applied).toBe(true);
    expect(res.patched).toContain("permissions:\n  contents: read");
    // Purely additive: no removed lines.
    const removed = res.diff!.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(removed).toEqual([]);
    const added = res.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(added).toEqual(["+permissions:", "+  contents: read"]);
  });

  test("no-op when a permissions block already exists", () => {
    const withPerms = WF.replace("jobs:", "permissions:\n  contents: read\njobs:");
    const res = proveFix("GHA017", withPerms);
    expect(res.applied).toBe(false);
  });

  test("narrows write-all (GHA033)", () => {
    const res = proveFix("GHA033", WF_WRITE_ALL);
    expect(res.applied).toBe(true);
    expect(res.patched).toContain("permissions:\n  contents: read");
    expect(res.patched).not.toContain("write-all");
  });
});

describe("proveFix — pin image digest (GHA030/WGL031)", () => {
  const WF_IMG = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: node:20
`;
  const digest = "sha256:" + "a".repeat(64);

  test("pins an image to a digest and the diff shows only that line", () => {
    const res = proveFix("GHA030", WF_IMG, { resolveDigest: () => digest });
    expect(res.applied).toBe(true);
    expect(res.patched).toContain(`image: node:20@${digest}`);
    const removed = res.diff!.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = res.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(removed).toEqual(["-      image: node:20"]);
    expect(added).toEqual([`+      image: node:20@${digest}`]);
  });

  test("needs a value when no digest can be resolved", () => {
    const res = proveFix("GHA030", WF_IMG, { resolveDigest: () => undefined });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("needs-input");
  });

  test("WGL031 uses the same image-pin fix", () => {
    const gl = "build:\n  image: python:3.12\n  script:\n    - echo hi\n";
    const res = proveFix("WGL031", gl, { resolveDigest: () => digest });
    expect(res.applied).toBe(true);
    expect(res.patched).toContain(`image: python:3.12@${digest}`);
  });

  test("extractUnpinnedImages finds pinnable images, skips digested/variable", () => {
    const content = "image: node:20\nimage: foo@sha256:" + "b".repeat(64) + "\nimage: $REG/x:1\n";
    expect(extractUnpinnedImages(content)).toEqual(["node:20"]);
  });
});

describe("proveFix — guidance findings are not auto-fixed", () => {
  test("a guidance rule returns remediation, not a patch", () => {
    const res = proveFix("GHA036", WF); // script injection — guidance
    expect(res.applied).toBe(false);
    expect(res.patched).toBeUndefined();
    expect(res.note && res.note.length).toBeGreaterThan(0);
  });
});

describe("unifiedDiff", () => {
  test("identical input produces an empty diff", () => {
    expect(unifiedDiff(WF, WF)).toBe("");
  });

  test("emits a hunk header and the changed lines", () => {
    const a = "a\nb\nc\n";
    const b = "a\nB\nc\n";
    const diff = unifiedDiff(a, b);
    expect(diff).toContain("@@");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain(" a");
  });
});
