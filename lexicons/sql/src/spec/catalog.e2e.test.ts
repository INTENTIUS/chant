/**
 * The committed snapshot is what the pinned server reports, byte for byte.
 *
 * Opt-in: it pulls the ~850 MB server image. Run it on a pin move, or when the
 * snapshot is edited by hand, with Docker available:
 *
 *     CHANT_SQL_LIVE=1 npx vitest run lexicons/sql/src/spec/catalog.e2e.test.ts
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../clickhouse/container";
import { catalogFromServer, SNAPSHOT_FILE } from "./fetch";
import { stringifyCatalog } from "./catalog";
import { clickhouseImage } from "./pin";

const enabled = process.env.CHANT_SQL_LIVE === "1" && (await dockerAvailable());
let server: ScratchServer | undefined;

afterAll(async () => {
  await server?.stop();
});

describe.skipIf(!enabled)("the snapshot against the pinned server", () => {
  test("reads back byte-identical", async () => {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-catalog-e2e" });
    const fresh = await catalogFromServer(server.endpoint, clickhouseImage());
    expect(stringifyCatalog(fresh)).toBe(readFileSync(SNAPSHOT_FILE, "utf-8"));
  }, 600_000);
});
