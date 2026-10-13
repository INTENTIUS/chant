/**
 * Reading the sql lexicon's build output in a post-synth check: the JSON
 * document the serializer writes (`dialect`, `applyOrder`, `objects`). The
 * documents are found by `../../read/objects.ts`, the same path the public
 * read API (`@intentius/chant-lexicon-sql/read`) takes.
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { dialectObjects, recordedPostgresMajor, type SqlObjectJson } from "../../read/objects";

export interface OutputObject extends SqlObjectJson {
  database?: string;
  engine?: { name: string; args?: string[] };
}

/** Every schema object in the build's sql output, ClickHouse dialect. */
export function clickhouseObjects(ctx: PostSynthContext): OutputObject[] {
  return dialectObjects(ctx, "clickhouse") as OutputObject[];
}

/** Every schema object in the build's sql output, Postgres dialect. */
export function postgresObjects(ctx: PostSynthContext): OutputObject[] {
  return dialectObjects(ctx, "postgres") as OutputObject[];
}

/**
 * The Postgres major the build targets, as the serializer recorded it
 * (`sql.postgresMajor`, else the newest pinned major). `fallback` answers for
 * output that carries none.
 */
export function postgresMajorOf(ctx: PostSynthContext, fallback: number): number {
  return recordedPostgresMajor(ctx, fallback);
}
