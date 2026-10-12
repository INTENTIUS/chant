import type { PostSynthCheck, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readClickHouse } from "@intentius/chant-lexicon-sql/read";

/**
 * The ClickHouse form of the same rule, for a project with
 * `sql: { dialect: "clickhouse" }`: every MergeTree table has a non-Nullable
 * `created_at` DateTime or DateTime64 column, and no Nullable column in its sort key.
 */
export const clickhouseCreatedAt: PostSynthCheck = {
  id: "ORG-CH-CREATED-AT",
  description: "every MergeTree table has a non-Nullable created_at DateTime and no Nullable sort key column",
  check(ctx): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const t of readClickHouse(ctx).tables) {
      if (!t.mergeTree) continue;
      const c = t.column("created_at");
      if (!c || c.nullable || (c.family !== "DateTime" && c.family !== "DateTime64")) {
        out.push({ checkId: "ORG-CH-CREATED-AT", severity: "error", entity: t.export, message: `${t.qualifiedName} needs created_at DateTime, not Nullable` });
      }
      for (const k of t.columns.filter((col) => col.inSortKey && col.nullable)) {
        out.push({ checkId: "ORG-CH-CREATED-AT", severity: "error", entity: t.export, message: `${t.qualifiedName}.${k.name} is Nullable and in the sort key` });
      }
    }
    return out;
  },
};
