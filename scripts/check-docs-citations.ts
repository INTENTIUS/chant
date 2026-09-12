#!/usr/bin/env tsx
/**
 * chant#2425 — gate the docs' rule citations against the published
 * specification.
 *
 * chant#2306 was three claims in `docs/.../concepts/typescript-as-data.mdx`
 * and `architecture/sandbox.mdx` describing a subset the specification no
 * longer had, in a shape the `###`-heading parity gate (#1062) cannot see,
 * because that one only looks at fenced blocks under headings. This looks at
 * rule identifiers instead, and it is the specification's own check rather
 * than a second implementation of it: `checkCitations` and `loadRules` come
 * from `@intentius/tsad-conformance`, which is where the rules live.
 *
 * Two things a document can do, and what each is held to:
 *
 *   - Mention an identifier in prose. It must be a rule at the version chant
 *     declares. The identifier is a link, and a link to nothing is the
 *     failure; nothing about the surrounding claim is checked.
 *   - Quote a rule, as a blockquote directly under a marker line whose content
 *     is `rule: F-X`. The quote must occur verbatim in the rule's own text,
 *     because a paraphrase is a claim the gate cannot check.
 *
 * ## Where the package comes from, for now
 *
 * `@intentius/tsad-conformance` is built and gated in the specification's
 * repository and is not on npm yet (INTENTIUS/typescript-as-data#23 is waiting
 * on the registry records). Until it is, CI checks the specification's public
 * repository out at a pinned commit and this script loads the package from
 * there; see
 * {@link SPEC_CHECKOUT} and `.github/workflows/docs-check.yml`.
 *
 * The moment it publishes, this becomes a devDependency and a plain vitest
 * file beside `packages/core/src/fold/subset-doc-parity.test.ts`. Both halves
 * of the resolution below are deliberate and neither is silent: an installed
 * package wins, a checkout is the fallback, and finding neither is a failure
 * rather than a skip. A citation gate that quietly passes when it could not
 * load the rules would be worse than no gate, since it reports the same green
 * as a real pass.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs", "src", "content", "docs");

/**
 * Where CI puts the specification's repository, and what a developer can point
 * at a local clone with. The workflow pins a commit; `spec/VERSION` inside it is
 * compared against chant's own `SPEC_VERSION` by the check itself, so a
 * checkout of the wrong version fails loudly rather than gating against rules
 * chant does not claim to implement.
 */
const SPEC_CHECKOUT = process.env.TSAD_CONFORMANCE_SRC ?? join(ROOT, ".tsad", "packages", "conformance", "src", "index.ts");

interface CitationFinding {
  kind: string;
}

interface Conformance {
  loadRules(specDir: string): { version: string; rules: ReadonlyMap<string, unknown> };
  checkCitations(document: string, index: { version: string; rules: ReadonlyMap<string, unknown> }, declared?: string): CitationFinding[];
  describeFinding(finding: CitationFinding): string;
  bundledSpecDir(): string;
}

/** The installed package if there is one, else the checkout. Never neither. */
async function loadConformance(): Promise<{ mod: Conformance; from: string }> {
  // The specifier is a variable on purpose: the package is not installed yet,
  // and a literal here would be a module the repo-wide typecheck cannot
  // resolve. It becomes a literal import in the same commit that adds the
  // devDependency.
  const installed = "@intentius/tsad-conformance";
  try {
    const mod = (await import(installed)) as unknown as Conformance;
    return { mod, from: `the installed ${installed}` };
  } catch {
    // Not installed, which is expected until it is on npm.
  }
  if (existsSync(SPEC_CHECKOUT)) {
    const mod = (await import(pathToFileURL(SPEC_CHECKOUT).href)) as unknown as Conformance;
    return { mod, from: relative(ROOT, SPEC_CHECKOUT) };
  }
  throw new Error(
    `cannot load @intentius/tsad-conformance.\n` +
      `  It is not installed, and there is no checkout at ${relative(ROOT, SPEC_CHECKOUT)}.\n` +
      `  CI checks the specification out there; locally, point TSAD_CONFORMANCE_SRC at\n` +
      `  <a typescript-as-data clone>/packages/conformance/src/index.ts.`,
  );
}

function docFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return docFiles(path);
      return /\.mdx?$/.test(entry) ? [path] : [];
    })
    .sort();
}

async function main(): Promise<number> {
  const { mod, from } = await loadConformance();
  const { SPEC_VERSION } = await import("../packages/core/src/fold/subset");

  const index = mod.loadRules(mod.bundledSpecDir());
  if (index.version !== SPEC_VERSION) {
    console.error(
      `Docs citations: chant declares specification ${SPEC_VERSION}, the loaded rules are ${index.version}.\n` +
        `  Either chant's SPEC_VERSION (packages/core/src/fold/subset.ts) or the pinned specification is stale.`,
    );
    return 1;
  }

  const files = docFiles(DOCS);
  let findings = 0;
  for (const file of files) {
    for (const finding of mod.checkCitations(readFileSync(file, "utf8"), index, SPEC_VERSION)) {
      if (findings === 0) console.error("Docs citations: findings against the specification.\n");
      findings++;
      console.error(`  ${relative(ROOT, file)}: ${mod.describeFinding(finding)}`);
    }
  }

  if (findings > 0) {
    console.error(
      `\n${findings} finding(s). A mention must name a rule that exists; a quote under a\n` +
        `\`{/* rule: F-X */}\` marker must be the rule's own text, verbatim.`,
    );
    return 1;
  }

  console.error(
    `Docs citations: ${files.length} file(s) clean against specification ${index.version} ` +
      `(${index.rules.size} rules, from ${from}).`,
  );
  return 0;
}

process.exitCode = await main();
