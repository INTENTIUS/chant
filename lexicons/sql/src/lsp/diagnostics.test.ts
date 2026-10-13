import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { runLint } from "@intentius/chant/lint/engine";
import { toLspDiagnostics } from "@intentius/chant/cli/lsp/diagnostics";
import { sqlPlugin } from "../plugin";

/** The editor's diagnostics are the lint rules' (chant serve lsp runs `lintRules()`), so a parse error shows at the token. */
describe("sql diagnostics in the editor", () => {
  test("DDL that does not parse is an error at the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-lsp-"));
    try {
      const file = join(dir, "schema.ts");
      writeFileSync(
        file,
        'import { table } from "@intentius/chant-lexicon-sql/clickhouse";\nexport const t = table`CREATE TABLE t (\n  a Strin g\n) ENGINE = Log`;\n',
      );
      const { diagnostics } = await runLint([file], sqlPlugin.lintRules!());
      const [d] = toLspDiagnostics(diagnostics.filter((x) => x.ruleId === "SQLCH001"));
      expect(d).toMatchObject({ code: "SQLCH001", severity: 1, range: { start: { line: 2, character: 10 } } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
