import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { sqlSerializer } from "@intentius/chant-lexicon-sql";

describeAllExamples(
  {
    lexicon: "sql",
    serializer: sqlSerializer,
    outputKey: "sql",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        const doc = JSON.parse(output) as { applyOrder: string[]; objects: Array<{ export: string; lineage?: unknown }> };
        expect(doc.applyOrder).toEqual(["analytics", "dailyActive", "events", "dailyActiveMv", "users"]);
        expect(doc.objects.find((o) => o.export === "dailyActiveMv")?.lineage).toEqual([
          { output: "day", expr: "toDate(ts)", from: ["events.ts"] },
          { output: "kind", expr: "kind", from: ["events.kind"] },
          { output: "users", expr: "uniqState(user_id)", from: ["events.user_id"] },
        ]);
      },
    },
  },
);
