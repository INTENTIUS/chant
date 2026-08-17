import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as opIndex from "./index";
import * as builders from "./builders";

/**
 * chant #1715 — `op/index.ts` re-exports the step builders from `./builders`
 * by name, in a hand-maintained list of forty-odd identifiers. `waitForReady`
 * — the CRD-aware readiness builder #365 added, with its own readiness spec,
 * kstatus default and per-kind overrides — was defined in `builders.ts` and
 * missing from that list, so no project could reach it from the day it landed.
 * The activity behind it had been registered in the k8s lexicon the whole
 * time; nothing noticed because every readiness wait in the repo predates it.
 *
 * The list drifting from the thing it lists is the bug, not the one missing
 * name. Same shape as #1347's assertion over the `LexiconPlugin` optional-member
 * table.
 */
describe("op builders are all reachable (#1715)", () => {
  test("every value exported from builders.ts is re-exported from op/index.ts", () => {
    const missing = Object.keys(builders).filter((name) => !(name in opIndex));
    expect(
      missing,
      `builders.ts exports these, and op/index.ts does not re-export them — add them to the ` +
        `export list at the top of op/index.ts, or a project cannot use them:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the temporal lexicon re-exports the same set", () => {
    // The lexicon is what a project actually imports from
    // (`@intentius/chant-lexicon-temporal`), and it re-states the list a third
    // time rather than re-exporting wholesale — so it can drift independently.
    const src = readFileSync(
      join(import.meta.dirname, "../../../../lexicons/temporal/src/index.ts"),
      "utf-8",
    );
    const block = src.match(/export \{([^}]*)\} from "@intentius\/chant\/op";/)?.[1] ?? "";
    const reExported = new Set(
      block.split(",").map((s) => s.trim()).filter(Boolean),
    );
    // The sprites family reaches projects through the fly lexicon, not this
    // one. Named rather than prefix-matched, because `listCheckpoints` is one
    // of them and does not look like one — which this test caught on its
    // first run.
    const FLY_SURFACE = new Set([
      "spriteCreate", "spriteExec", "spriteCheckpoint", "spriteRestore",
      "listCheckpoints", "spriteDestroy", "spriteWriteFile", "spriteReadFile",
      "spriteListDir", "spriteRemove", "spriteApplyNetworkPolicy",
      "spriteApplyServices", "spriteTaskCreate", "spriteTaskRefresh",
      "spriteTaskRelease", "spritesUp", "spritesDown",
    ]);
    const expected = Object.keys(builders).filter((n) => !FLY_SURFACE.has(n));
    const missing = expected.filter((name) => !reExported.has(name));
    expect(
      missing,
      `lexicons/temporal/src/index.ts does not re-export these builders:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});
