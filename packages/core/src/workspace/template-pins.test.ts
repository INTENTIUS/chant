/**
 * Re-pinning records after template substitution (#2549): a pin that held in
 * the template follows the substituted file, one that didn't stays, and the
 * rest of the record is kept byte for byte.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { repinSubstituted } from "./template-pins";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const buf = (s: string) => Buffer.from(s, "utf-8");

function record(pins: [string, string][]): string {
  const evidence = pins.map(([path, hash]) => `  - title: "t"\n    path: "${path}"\n    sha256: "${hash}"\n`).join("");
  return `---\nschema: 1\nid: "ref-002"\nevidence:\n  - title: "a link"\n    url: "https://example.com"\n${evidence}constrains:\n  - "member:design"\n---\n\n# Body mentions ${pins[0]?.[1] ?? ""}\n`;
}

describe("repinSubstituted", () => {
  const before = "title {{chant:name}}\n";
  const after = "title Acme\n";
  const other = "unchanged\n";

  test("a pin that held on a substituted file gets the new hash; nothing else in the file changes", () => {
    const text = record([["design/home.json", sha(before)], ["design/other.json", sha(other)]]);
    const original = new Map([
      ["chant.workspace.json", buf("{}")],
      ["design/home.json", buf(before)],
      ["design/other.json", buf(other)],
      ["decisions/ref-002-x.md", buf(text)],
    ]);
    const substituted = new Map(original).set("design/home.json", buf(after));
    const { files, repinned } = repinSubstituted(original, substituted, ["design/home.json"]);
    expect(repinned).toEqual([{ record: "decisions/ref-002-x.md", paths: ["design/home.json"] }]);
    const expected = text.replace(`    sha256: "${sha(before)}"`, `    sha256: "${sha(after)}"`);
    expect(files.get("decisions/ref-002-x.md")!.toString("utf-8")).toBe(expected);
    // The body's copy of the old hash is not front matter, so it stays.
    expect(expected).toContain(`# Body mentions ${sha(before)}`);
  });

  test("a pin that was already drifted in the template stays drifted", () => {
    const text = record([["design/home.json", sha("something else")]]);
    const original = new Map([
      ["design/home.json", buf(before)],
      ["decisions/ref-002-x.md", buf(text)],
    ]);
    const substituted = new Map(original).set("design/home.json", buf(after));
    const { files, repinned } = repinSubstituted(original, substituted, ["design/home.json"]);
    expect(repinned).toEqual([]);
    expect(files.get("decisions/ref-002-x.md")!.toString("utf-8")).toBe(text);
  });

  test("paths resolve from the workspace declaration nearest above the record", () => {
    const text = record([["design/home.json", sha(before)]]);
    const original = new Map([
      ["ws/chant.workspace.json", buf("{}")],
      ["ws/design/home.json", buf(before)],
      ["ws/decisions/ref-002-x.md", buf(text)],
    ]);
    const substituted = new Map(original).set("ws/design/home.json", buf(after));
    const { repinned } = repinSubstituted(original, substituted, ["ws/design/home.json"]);
    expect(repinned).toEqual([{ record: "ws/decisions/ref-002-x.md", paths: ["design/home.json"] }]);
  });

  test("nothing substituted, nothing re-pinned", () => {
    const original = new Map([["decisions/ref-002-x.md", buf(record([["design/home.json", sha(before)]]))]]);
    expect(repinSubstituted(original, original, []).repinned).toEqual([]);
  });
});
