import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClient } from "../testing/fake-client";
import { sqlPlugin } from "../../plugin";

vi.mock("../live/bind", async (orig) => ({
  ...(await orig<typeof import("../live/bind")>()),
  bindPostgres: async () => ({
    target: { endpoint: { url: "postgres://x/db" }, source: "test", defaultSchema: "public" },
    client: fakeClient({
      schemas: [{ name: "app" }],
      tables: [
        { schema: "public", name: "_prisma_migrations" },
        { schema: "app", name: "users", columns: [{ name: "id", type: "bigint", notnull: true }] },
      ],
    }),
  }),
}));

vi.mock("../../live-dialect", async (orig) => ({
  ...(await orig<typeof import("../../live-dialect")>()),
  resolveBindingDialect: async () => "postgres",
}));

describe("a Postgres import prints what it left out (#3336)", () => {
  test("the ORM table's warning reaches the import result", async () => {
    const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
    const dir = mkdtempSync(join(tmpdir(), "pg-import-warn-"));
    try {
      const result = await liveImportFromPlugins([sqlPlugin], {
        environment: "prod",
        lexicon: "sql",
        output: join(dir, "infra"),
        force: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => w.includes("_prisma_migrations") && w.includes("Prisma Migrate"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
