import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { sqlTypesPath, sqlTypesState } from "../../sql-types";

/**
 * SQL102: `sql-types.d.ts` no longer matches what the build declares.
 *
 * tsc checks a typed tag's columns, and the foreign-key and sort-key slots,
 * against the generated file, never against the template text, so a stale file
 * keeps checking the old types. The check renders the declarations in memory
 * (the render `chant sql types` writes) and compares them with the file in the
 * project's source directory. Silent when the context carries no project
 * directory (a hand-built one) or the file does not exist, so a project that
 * has not adopted typed columns, or keeps the file elsewhere, sees nothing.
 * `chant sql types --check` is the same comparison without a build, and a
 * workspace `generated` entry runs it under `chant workspace check --generated`.
 */
export const sql102: PostSynthCheck = {
  id: "SQL102",
  description: "sql-types.d.ts differs from what the build declares",
  check(ctx) {
    if (!ctx.projectDir) return [];
    const file = sqlTypesPath(ctx.projectDir, ctx.projectConfig);
    const state = sqlTypesState(ctx.entities, file, { projectDir: ctx.projectDir, config: ctx.projectConfig });
    if (state !== "stale") return [];
    return [
      {
        checkId: "SQL102",
        severity: "error",
        message: `${file} differs from what the build declares, so tsc checks columns against out-of-date types; run \`chant sql types\` to rewrite it`,
        lexicon: "sql",
      },
    ];
  },
};
