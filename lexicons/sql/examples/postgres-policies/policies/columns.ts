import type { PostSynthCheck, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { canonicalPostgresType, readPostgres } from "@intentius/chant-lexicon-sql/read";

const TIMESTAMPTZ = canonicalPostgresType("timestamptz");

/** Every table has `created_at timestamptz NOT NULL`, however the DDL spells the type. */
export const createdAt: PostSynthCheck = {
  id: "ORG-CREATED-AT",
  description: "every table has created_at timestamptz NOT NULL",
  check(ctx): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const t of readPostgres(ctx).tables) {
      const c = t.column("created_at");
      if (c && c.typeName === TIMESTAMPTZ && !c.nullable) continue;
      out.push({
        checkId: "ORG-CREATED-AT",
        severity: "error",
        entity: t.export,
        message: c
          ? `${t.qualifiedName}.created_at is ${c.type}${c.nullable ? ", nullable" : ""}; make it timestamptz NOT NULL`
          : `${t.qualifiedName} has no created_at column; add created_at timestamptz NOT NULL DEFAULT now()`,
      });
    }
    return out;
  },
};

/** In prod, every column but the primary key has a comment. */
export const columnComments: PostSynthCheck = {
  id: "ORG-COLUMN-COMMENTS",
  description: "in prod, every column outside the primary key has a COMMENT",
  check(ctx): PostSynthDiagnostic[] {
    if (ctx.env !== "prod") return [];
    return readPostgres(ctx).tables.flatMap((t) =>
      t.columns
        .filter((c) => !c.inPrimaryKey && !c.comment)
        .map((c): PostSynthDiagnostic => ({
          checkId: "ORG-COLUMN-COMMENTS",
          severity: "warning",
          entity: t.export,
          message: `${t.qualifiedName}.${c.name} has no comment`,
        })),
    );
  },
};
