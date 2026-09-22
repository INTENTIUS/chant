/**
 * The behaviour coverage page still says what the rows say (chant #2404).
 *
 * A coverage page's whole value is that it is current. The rows live in three
 * lexicons and the page in core's docs, so nothing but this test connects
 * them: it fails when the committed block differs from what
 * `test/behaviour-coverage.ts` renders, when a row is on the page twice or
 * not at all, and when a lexicon starts contributing `behaviourKinds` without
 * being listed. Same construction as `./no-egress.test.ts`'s catalogue check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEHAVIOUR_COVERAGE_CONTRIBUTORS,
  BEHAVIOUR_COVERAGE_DOC,
  BEHAVIOUR_COVERAGE_END,
  BEHAVIOUR_COVERAGE_START,
  extractBehaviourCoverageBlock,
  renderBehaviourCoverageBlock,
  renderContributor,
  replaceBehaviourCoverageBlock,
  type CoverageContributor,
} from "./behaviour-coverage";
import { coverageFor, isEngineKind } from "../packages/core/src/behaviour-kinds";

const repoRoot = join(__dirname, "..");
const page = readFileSync(join(repoRoot, BEHAVIOUR_COVERAGE_DOC), "utf-8");

describe("the behaviour coverage page", () => {
  it("carries the block exactly as the rows render it (run `npm run generate:behaviour-coverage`)", () => {
    expect(extractBehaviourCoverageBlock(page)).toBe(renderBehaviourCoverageBlock());
  });

  it("gives every mapped and declared-unmapped type exactly one row", () => {
    for (const contributor of BEHAVIOUR_COVERAGE_CONTRIBUTORS) {
      const types = [...Object.keys(contributor.kinds.mapped ?? {}), ...Object.keys(contributor.kinds.unmapped ?? {})];
      expect(types.length).toBeGreaterThan(0);
      for (const type of types) {
        const rows = page.split("\n").filter((line) => line.startsWith(`| \`${type}\` |`));
        expect(rows.length, `${type} appears on ${rows.length} rows`).toBe(1);
      }
    }
  });

  it("lists every substrate boundary the terraform lexicon states", () => {
    const terraform = BEHAVIOUR_COVERAGE_CONTRIBUTORS.find((c) => c.lexicon === "terraform");
    expect(terraform?.substrates?.length).toBeGreaterThan(0);
    for (const { prefix } of terraform?.substrates ?? []) {
      expect(page).toContain(`| \`${prefix}\` |`);
    }
  });

  it("states the rules that cannot be enumerated with the sentence the rule itself gives", () => {
    const aws = BEHAVIOUR_COVERAGE_CONTRIBUTORS.find((c) => c.lexicon === "aws");
    const verdict = coverageFor([aws!.kinds], aws!.unmappedWitness!);
    expect(verdict.status).toBe("declared-unmapped");
    expect(page).toContain((verdict as { reason: string }).reason);
    const terraform = BEHAVIOUR_COVERAGE_CONTRIBUTORS.find((c) => c.lexicon === "terraform");
    const boundary = coverageFor([terraform!.kinds], "Terraform::Resource", { address: `${terraform!.notModelledWitness}.x` });
    expect(boundary.status).toBe("provider-not-modelled");
    expect(page).toContain((boundary as { substrate: string }).substrate);
  });

  it("lists every lexicon whose plugin contributes behaviourKinds", () => {
    const listed = new Set(BEHAVIOUR_COVERAGE_CONTRIBUTORS.map((c) => c.lexicon));
    const contributing: string[] = [];
    for (const lexicon of readdirSync(join(repoRoot, "lexicons"))) {
      let plugin: string;
      try {
        plugin = readFileSync(join(repoRoot, "lexicons", lexicon, "src", "plugin.ts"), "utf-8");
      } catch {
        continue;
      }
      if (/^\s*behaviourKinds\b/m.test(plugin)) contributing.push(lexicon);
    }
    expect(contributing.length).toBeGreaterThanOrEqual(3);
    for (const lexicon of contributing) {
      expect(listed.has(lexicon), `lexicons/${lexicon} contributes behaviourKinds and is not on the page`).toBe(true);
    }
  });

  it("names a legal engine kind on every mapped row", () => {
    for (const contributor of BEHAVIOUR_COVERAGE_CONTRIBUTORS) {
      for (const [type, mapping] of Object.entries(contributor.kinds.mapped ?? {})) {
        expect(isEngineKind(mapping.kind), `${type}: ${mapping.kind}`).toBe(true);
      }
    }
  });
});

describe("rendering", () => {
  const stub: CoverageContributor = {
    lexicon: "stub",
    source: "lexicons/stub/src/behaviour-kinds.ts",
    keyedBy: "the entity type",
    kinds: {
      provider: "stub",
      prefixes: ["Stub::"],
      mapped: {
        "Stub::Zed": { kind: "compute", sizeProp: "Size|Big", sizeType: "number", regionProp: "Zone" },
        "Stub::Alpha": { kind: "queue" },
        "Stub::Other": { kind: "cache", provider: "elsewhere" },
      },
      unmapped: { "Stub::Grant": "a grant, with a | in the reason" },
      unmappedWhen: (type) => (type.includes(".") ? "a nested block" : undefined),
    },
    unmappedWitness: "Stub::Zed.Inner",
  };

  it("sorts rows by code unit, escapes pipes, and says when a row's provider differs", () => {
    const text = renderContributor(stub).join("\n");
    const alpha = text.indexOf("| `Stub::Alpha` |");
    const other = text.indexOf("| `Stub::Other` |");
    const zed = text.indexOf("| `Stub::Zed` |");
    expect(alpha).toBeGreaterThan(-1);
    expect(alpha).toBeLessThan(other);
    expect(other).toBeLessThan(zed);
    expect(text).toContain("| `Stub::Zed` | compute | `Size\\|Big` (number) | `Zone`, else the request's |");
    expect(text).toContain("| `Stub::Alpha` | queue | none | the request's |");
    expect(text).toContain("| `Stub::Other` | cache (provider `elsewhere`) | none | the request's |");
    expect(text).toContain("| `Stub::Grant` | a grant, with a \\| in the reason |");
    expect(text).toContain("| `Stub::Zed.Inner`, by rule | declared unmapped | a nested block |");
    expect(text).toContain("#### Mapped (3)");
    expect(text).toContain("#### Declared unmapped (1)");
    expect(text).toContain("| any other `Stub::` type | unknown-type, the one verdict that is a defect | the entity has no row");
    expect(text).toContain("the lexicon that owns Stub::");
    expect(text).toContain("| `Stub::` | the entity type | `stub` | `lexicons/stub/src/behaviour-kinds.ts` |");
  });

  it("renders a nothing-priced lexicon as one sentence and no tables", () => {
    const text = renderContributor({
      lexicon: "ci",
      source: "lexicons/ci/src/plugin.ts",
      keyedBy: "the entity type",
      kinds: { provider: "ci", prefixes: ["CI::"], nothingPriced: "a CI workflow is not an estate" },
    }).join("\n");
    expect(text).toContain("Nothing this lexicon declares is priced: a CI workflow is not an estate.");
    expect(text).not.toContain("#### Mapped");
    expect(text).not.toContain("| Type |");
    expect(text).not.toContain("unknown-type");
  });

  it("refuses to render a rule whose witness it cannot answer", () => {
    expect(() => renderContributor({ ...stub, unmappedWitness: "Stub::NoDot" })).toThrow(/witness/);
  });

  it("replaces only what sits between the markers", () => {
    const doc = `before\n${BEHAVIOUR_COVERAGE_START}\nstale\n${BEHAVIOUR_COVERAGE_END}\nafter`;
    const replaced = replaceBehaviourCoverageBlock(doc);
    expect(replaced.startsWith("before\n")).toBe(true);
    expect(replaced.endsWith("\nafter")).toBe(true);
    expect(replaced).not.toContain("stale");
    expect(replaced).toContain("### aws");
    expect(() => extractBehaviourCoverageBlock("no markers")).toThrow(/markers not found/);
  });
});
