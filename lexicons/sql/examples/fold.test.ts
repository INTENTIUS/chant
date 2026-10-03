/**
 * The examples build to the same bytes folded as run (#3196): `chant build`
 * reduces the tags without running the files, and the result must be what
 * running them produces.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlPlugin, sqlSerializer } from "@intentius/chant-lexicon-sql";

const EXAMPLES = ["getting-started", "events-pipeline", "cdc-mirror", "sharded-cluster", "rebuild-migration", "postgres-getting-started"];

describe("the examples, folded and run", () => {
  test.each(EXAMPLES)("%s builds byte-identical both ways", async (example) => {
    const src = join(import.meta.dirname, example, "src");
    const intrinsics = sqlPlugin.intrinsics!();
    const folded = await build(src, [sqlSerializer], undefined, { fold: true, intrinsics, lexicons: ["sql"] });
    const ran = await build(src, [sqlSerializer], undefined, { fold: false, intrinsics, lexicons: ["sql"] });
    expect(folded.errors).toEqual([]);
    expect(ran.errors).toEqual([]);
    const a = folded.outputs.get("sql") as SerializerResult;
    const b = ran.outputs.get("sql") as SerializerResult;
    expect(a.primary).toBe(b.primary);
    expect(a.files).toEqual(b.files);
  });
});
