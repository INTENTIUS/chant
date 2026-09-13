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
 * `@intentius/tsad-conformance` is a devDependency, published on npm since
 * `1.8.0` (INTENTIUS/typescript-as-data#23). Before that CI checked the
 * specification's repository out at a pinned commit and this script loaded the
 * package from there; chant#2470 removed that, along with the `.tsad` steps in
 * `docs-check.yml`.
 *
 * It stays a script rather than a vitest file because it wants a real
 * `@intentius/tsad-conformance` and the docs tree, not chant's source, and
 * `docs-check.yml` is where the rest of the docs gates live.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs", "src", "content", "docs");

import { checkCitations, loadRules, describeFinding, bundledSpecDir } from "@intentius/tsad-conformance";

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
  const { SPEC_VERSION } = await import("../packages/core/src/fold/subset");

  const index = loadRules(bundledSpecDir());
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
    for (const finding of checkCitations(readFileSync(file, "utf8"), index, SPEC_VERSION)) {
      if (findings === 0) console.error("Docs citations: findings against the specification.\n");
      findings++;
      console.error(`  ${relative(ROOT, file)}: ${describeFinding(finding)}`);
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
      `(${index.rules.size} rules).`,
  );
  return 0;
}

process.exitCode = await main();
