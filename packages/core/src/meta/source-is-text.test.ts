import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every shipped source file is text a text tool can read.
 *
 * chant#2280 — `graph-ir.ts` carried three literal NUL bytes inside a template
 * literal, used as separators in a composite key. The value was right and the
 * code worked; what broke was everything that reads the file as text. ripgrep
 * classifies a file containing NUL as binary, so it answers `binary file
 * matches (found a NUL byte around offset 32631)` instead of the matching
 * lines, and a repo-wide search does not list the file at all. 911 lines were
 * invisible to every grep-driven search of this repository for as long as the
 * bytes were there.
 *
 * That is worse than a silent bug, because it is a silent bug in the tool you
 * would use to find bugs. Any audit, any "I searched the codebase", any
 * refactor that greps for a symbol defined in that file quietly skipped it and
 * reported success.
 *
 * The fix is not to stop using NUL as a separator — it is a good one, being the
 * character that cannot appear in an identifier or an attribute name. It is to
 * write it as an escape, four ASCII characters in the file and the same single
 * code unit at runtime.
 */
const SRC = fileURLToPath(new URL("../", import.meta.url));

/** Every TypeScript file under core's src, tests and fixtures included. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|mts|cts)$/.test(entry) ? [path] : [];
  });
}

describe("source files are text, not binary (chant#2280)", () => {
  test("no shipped source file contains a NUL byte", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const buf = readFileSync(file);
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${relative(SRC, file)} (first at byte ${at})`);
    }

    expect(
      offenders,
      "a NUL byte makes ripgrep treat the file as binary, so it reports a " +
        "binary-file-matches line instead of the matches and a repo-wide search omits " +
        "the file entirely. Write the character as a unicode escape instead — same " +
        "value at runtime, plain ASCII in the file.",
    ).toEqual([]);
  });

  test("the composite edge key still separates on NUL, which is the point of using it", () => {
    // Guards the fix rather than the file: the escape must denote the same
    // character the literal byte did, or the separator silently becomes
    // something that CAN occur in an identifier and distinct edges collide.
    const source = readFileSync(join(SRC, "graph-ir.ts"), "utf8");
    const key = source.split("\n").find((l) => l.includes("const key = `${edge.from}"));
    expect(key, "the composite edge key moved; check its separator is still NUL").toBeDefined();
    expect(key).toContain("\\u0000");

    // And the escape really is the NUL character, not a look-alike. Built with
    // fromCharCode so this file stays plain ASCII and does not fail its own gate.
    const nul = String.fromCharCode(0);
    expect(`a${nul}b`.charCodeAt(1)).toBe(0);
    expect(`a${nul}b`.split(nul)).toEqual(["a", "b"]);
  });
});
