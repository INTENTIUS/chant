import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which lexicon test artifacts a checkout is missing (chant #1419).
 *
 * Lexicon tests import each lexicon's generated barrel and bundled
 * `dist/meta.json`. Neither is committed; `prepack` builds them for a
 * published package and `just test` builds them through `_ensure-gen`, but
 * `npx vitest run` on a fresh clone gets `Cannot find module .../meta.json`
 * or plain assertion failures against an absent barrel. The checks here
 * mirror `_ensure-gen` in the justfile so the two stay in agreement about
 * what "generated" means; the vitest globalSetup turns a non-empty result
 * into one failure that names the lexicons and the command.
 */
export interface MissingArtifacts {
  lexicon: string;
  missing: string[];
}

function hasScript(pkgJson: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

function fileMentions(path: string, needle: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

function treeMentions(dir: string, needle: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (fileMentions(join(entry.parentPath, entry.name), needle)) return true;
  }
  return false;
}

export function findMissingLexiconArtifacts(root: string): MissingArtifacts[] {
  const lexiconsDir = join(root, "lexicons");
  if (!existsSync(lexiconsDir)) return [];
  const out: MissingArtifacts[] = [];
  for (const name of readdirSync(lexiconsDir).sort()) {
    const lex = join(lexiconsDir, name);
    const pkgJson = join(lex, "package.json");
    if (!hasScript(pkgJson, "generate")) continue;
    const missing: string[] = [];
    const barrel = join(lex, "src", "generated", "index.ts");
    if (fileMentions(join(lex, "src", "index.ts"), 'from "./generated') && !existsSync(barrel)) {
      missing.push("src/generated/index.ts");
    }
    if (
      existsSync(barrel) &&
      (treeMentions(join(lex, "src", "api"), "generated/operations.json") ||
        treeMentions(join(lex, "src", "codegen"), "generated/operations.json")) &&
      !existsSync(join(lex, "src", "generated", "operations.json"))
    ) {
      missing.push("src/generated/operations.json");
    }
    if (hasScript(pkgJson, "bundle")) {
      if (!existsSync(join(lex, "dist", "meta.json"))) missing.push("dist/meta.json");
      if (!existsSync(join(lex, "dist", "okf", "index.md"))) missing.push("dist/okf/index.md");
    }
    if (missing.length > 0) out.push({ lexicon: name, missing });
  }
  return out;
}

export function formatMissingArtifacts(found: MissingArtifacts[]): string {
  const names = found.map((f) => f.lexicon);
  const lines = [
    `Lexicon test artifacts are missing for: ${names.join(", ")}`,
    "",
    ...found.map((f) => `  lexicons/${f.lexicon}: ${f.missing.join(", ")}`),
    "",
    "These are generated, not committed. Lexicon tests import them, so on a",
    "fresh clone they fail with `Cannot find module .../dist/meta.json` or",
    "with assertion failures against an absent generated barrel.",
    "",
    "Build them once (idempotent, about a minute for every lexicon) with",
    "",
    "  just test        # runs _ensure-gen, then vitest",
    "  just regen       # force-rebuild every lexicon",
    "",
    "or per lexicon with",
    "",
    ...names.map((n) => `  npm run generate -w lexicons/${n} && npm run bundle -w lexicons/${n}`),
    "",
    "Set CHANT_SKIP_ARTIFACT_CHECK=1 to bypass this check.",
  ];
  return lines.join("\n");
}
