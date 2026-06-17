import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

/**
 * #428: the lexicon modules the hosted service imports on the edge — post-synth
 * checks (+ their local helpers) and the `detect` modules — must not run Node-only
 * APIs at module load. `createRequire(import.meta.url)` at module scope throws on
 * Workers (import.meta.url is undefined), crashing the worker at startup. Anything
 * that genuinely needs it must do so lazily, inside a function, behind a try.
 */
const lexiconsDir = fileURLToPath(new URL("../../../../lexicons", import.meta.url));

function edgeImportedFiles(): string[] {
  const out: string[] = [];
  for (const lex of readdirSync(lexiconsDir)) {
    const detect = join(lexiconsDir, lex, "src", "detect.ts");
    if (existsSync(detect)) out.push(detect);
    const ps = join(lexiconsDir, lex, "src", "lint", "post-synth");
    if (existsSync(ps)) {
      for (const f of readdirSync(ps)) {
        if (f.endsWith(".ts") && !f.endsWith(".test.ts")) out.push(join(ps, f));
      }
    }
  }
  return out;
}

describe("edge-imported lexicon modules are init-safe", () => {
  test("no module-scope createRequire(import.meta.url)", () => {
    const offenders: string[] = [];
    for (const file of edgeImportedFiles()) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        // Module scope = no leading whitespace. Inside a function it's indented.
        if (/^(const|let|var|\s*)?\S.*createRequire\(import\.meta\.url\)/.test(line) && !/^\s/.test(line)) {
          offenders.push(`${file.replace(lexiconsDir, "lexicons")}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, "move these into a function (lazy) — they crash edge bundles").toEqual([]);
  });
});
