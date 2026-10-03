/**
 * Reading the sql lexicon's build output in a post-synth check: the JSON
 * document the serializer writes (`dialect`, `applyOrder`, `objects`).
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";

export interface OutputObject {
  export: string;
  type: string;
  name: string;
  database?: string;
  engine?: { name: string; args?: string[] };
  [key: string]: unknown;
}

/** Every schema object in the build's sql output, ClickHouse dialect. */
export function clickhouseObjects(ctx: PostSynthContext): OutputObject[] {
  const out: OutputObject[] = [];
  for (const doc of ctx.docs ?? []) {
    if (doc.error || doc.lexicon !== "sql" || doc.format !== "json") continue;
    const value = doc.value as { dialect?: unknown; objects?: unknown };
    if (value?.dialect !== "clickhouse" || !Array.isArray(value.objects)) continue;
    out.push(...(value.objects as OutputObject[]));
  }
  return out;
}

/** Every schema object in the build's sql output, Postgres dialect. */
export function postgresObjects(ctx: PostSynthContext): OutputObject[] {
  const out: OutputObject[] = [];
  for (const doc of ctx.docs ?? []) {
    if (doc.error || doc.lexicon !== "sql" || doc.format !== "json") continue;
    const value = doc.value as { dialect?: unknown; objects?: unknown };
    if (value?.dialect !== "postgres" || !Array.isArray(value.objects)) continue;
    out.push(...(value.objects as OutputObject[]));
  }
  return out;
}
