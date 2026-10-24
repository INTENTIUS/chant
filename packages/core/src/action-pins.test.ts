import { describe, expect, it } from "vitest";
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
