import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `--param`/`--params-file` started as build-only flags and grew: `chant graph`
 * gained them with #1359 (graph and build disagreed about the same source),
 * `chant run --components` with #1108. The help text in `./main.ts` kept saying
 * "(build)", so the CLI's own documentation told users the flag did nothing on
 * the two commands that had just learned it.
 *
 * Asserting the property rather than the wording: every handler that actually
 * reads `args.param` must be named in the flag's help annotation. A new handler
 * honoring the flag fails this test until the help is updated with it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const handlersDir = join(here, "handlers");

/** The command name a handler file implements — `handlers/graph.ts` backs `chant graph`. */
function commandOf(file: string): string {
  return file.replace(/\.ts$/, "");
}

function handlersReadingParamFlags(): string[] {
  return readdirSync(handlersDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /\bargs\.param\b/.test(readFileSync(join(handlersDir, f), "utf-8")))
    .map(commandOf)
    .sort();
}

/**
 * The help text for one flag: everything from its marker up to the next flag
 * entry or the end of the options block, whichever comes first. Both bounds
 * matter — the LAST flag in a block has no `--` after it, and without the
 * blank-line bound its "block" would run to the end of the file and match
 * every command name incidentally.
 */
function helpBlockFor(flag: string): string {
  const source = readFileSync(join(here, "main.ts"), "utf-8");
  const start = source.indexOf(`  ${flag}`);
  expect(start, `${flag} is not documented in main.ts's help`).toBeGreaterThan(-1);
  const rest = source.slice(start + flag.length);
  const ends = [rest.search(/\n {2}--/), rest.search(/\n\s*\n/)].filter((i) => i !== -1);
  expect(ends.length, `${flag}'s help block has no terminator`).toBeGreaterThan(0);
  return rest.slice(0, Math.min(...ends));
}

describe("--param help annotation tracks the handlers that honor it", () => {
  test("at least build, graph and run read the flag", () => {
    // Guards the test itself: if the detection regex ever stops matching, the
    // assertions below would pass vacuously against an empty set.
    expect(handlersReadingParamFlags()).toEqual(expect.arrayContaining(["build", "graph", "run"]));
  });

  test.each(["--param <name=value>", "--params-file <path>"])(
    "%s names every command that honors it",
    (flag) => {
      const block = helpBlockFor(flag);
      for (const command of handlersReadingParamFlags()) {
        expect(
          block.includes(command),
          `handlers/${command}.ts reads args.param, but ${flag}'s help does not mention "${command}"`,
        ).toBe(true);
      }
    },
  );
});
