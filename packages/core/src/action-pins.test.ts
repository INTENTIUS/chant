import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_PINS, pinAtMajor, pinMajor, tagComments, unpinnedActions, usesRef } from "./action-pins";

describe("the action pin table", () => {
  it("holds a full commit SHA and a release of the row's major for every action", () => {
    for (const [key, p] of Object.entries(ACTION_PINS)) {
      expect({ key, sha: /^[0-9a-f]{40}$/.test(p.sha) }).toEqual({ key, sha: true });
      expect({ key, tag: p.tag.startsWith(`${p.major}.`) }).toEqual({ key, tag: true });
    }
  });

  it("finds a tag, a branch or a short SHA, and passes a full SHA, a local action and a docker image", () => {
    const yaml = [
      "      - uses: actions/checkout@v4",
      "        uses: https://code.forgejo.org/actions/cache@main",
      "      - uses: 'actions/setup-node@8207627'",
      `      - uses: actions/checkout@${"a".repeat(40)} # v4.4.0`,
      "      - uses: ./.github/actions/local",
      "      - uses: docker://alpine:3.20",
    ].join("\n");
    expect(unpinnedActions(yaml)).toEqual(["actions/checkout@v4", "https://code.forgejo.org/actions/cache@main", "actions/setup-node@8207627"]);
  });

  it("writes the release beside a pinned line once, and leaves an unknown SHA alone", () => {
    const line = `      - uses: ${usesRef(ACTION_PINS.checkout6)}`;
    const once = tagComments(line);
    expect(once).toBe(`${line} # ${ACTION_PINS.checkout6.tag}`);
    expect(tagComments(once)).toBe(once);
    expect(tagComments(`  uses: actions/checkout@${"f".repeat(40)}`)).toBe(`  uses: actions/checkout@${"f".repeat(40)}`);
  });

  it("moves a pinned upload-artifact to another major of the same action", () => {
    expect(pinAtMajor(ACTION_PINS.uploadArtifact4.sha, "v3")).toBe(ACTION_PINS.uploadArtifact3);
    expect(pinAtMajor(ACTION_PINS.uploadArtifact4.sha, "v9")).toBeUndefined();
    expect(pinAtMajor("0".repeat(40), "v3")).toBeUndefined();
    expect(pinMajor(ACTION_PINS.downloadArtifact4.sha)).toBe(4);
  });
});

// #4410: the places that are not generators pin too.
const repoRoot = join(__dirname, "../../..");

describe("hand-written actions are pinned (#4410)", () => {
  it("chant's own workflows name every action by a full commit SHA", () => {
    const dir = join(repoRoot, ".github/workflows");
    const unpinned: Record<string, string[]> = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
      const found = unpinnedActions(readFileSync(join(dir, f), "utf8"));
      if (found.length) unpinned[f] = found;
    }
    expect(unpinned).toEqual({});
  });

  it("every pinned line in chant's own workflows carries a release comment", () => {
    const dir = join(repoRoot, ".github/workflows");
    const bare: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (/uses: *[^\s#]+@[0-9a-f]{40}\s*$/.test(line)) bare.push(`${f}: ${line.trim()}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("no github composite writes a `uses:` tag literal; each takes its ref from the pin table", () => {
    const dir = join(repoRoot, "lexicons/github/src/composites");
    const literal: Record<string, string[]> = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const found = [...readFileSync(join(dir, f), "utf8").matchAll(/(?:uses|setupAction):\s*["'`]([^"'`]+)["'`]/g)]
        .map((m) => m[1])
        .filter((r) => unpinnedActions(`uses: ${r}`).length > 0);
      if (found.length) literal[f] = found;
    }
    expect(literal).toEqual({});
  });
});
