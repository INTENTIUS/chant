Product files the report store reads (#5336), kept unchanged.

- `terragucci-audit.jsonl`: `terragucci.audit/v1`, one line of each of its 18 kinds, from INTENTIUS/behold `src/__fixtures__/terragucci-audit.jsonl` at `7cf5055`.
- `terragucci-estate.json`: `terragucci.estate/v1`, from INTENTIUS/behold `example-terragucci-reports/estate.json` at `7cf5055`.
- `sql-yodeler-audit.jsonl`: sql-yodeler's `audit.jsonl`, written by its own `deriveAudit` (`src/report/audit.ts`, INTENTIUS/sql-yodeler `f1e1dc5`) from the history rows and ledger lines of its `test/report.test.ts` and `test/ledger-records.test.ts`, with a second failed row added so the file has a `failed` entry.

`../../ci-estate/__fixtures__/terragucci-dora.json` is terragucci's `dora.json`.
