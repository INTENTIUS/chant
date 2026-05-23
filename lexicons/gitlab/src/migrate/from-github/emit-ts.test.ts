import { describe, test, expect } from "vitest";
import { transform } from "./index";

describe("transform --emit ts", () => {
  test("produces TS source importing from @intentius/chant-lexicon-gitlab", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm run build
`;
    const result = await transform(yml, { emit: "ts", sourceFile: "ci.yml" });
    expect(result.output).toContain('from "@intentius/chant-lexicon-gitlab"');
    expect(result.output).toContain("new Job(");
    expect(result.output).toContain("Migrated from ci.yml");
  });

  test("emits TODO footer for NeedsReview items", async () => {
    const yml = `on: schedule
jobs:
  cron:
    runs-on: ubuntu-latest
    steps:
      - run: ./run.sh
`;
    const result = await transform(yml, { emit: "ts", sourceFile: "ci.yml" });
    expect(result.output).toContain("TODO(migration)");
    expect(result.output).toContain("MIG-ON-SCHEDULE");
  });

  test("yaml and ts emit modes produce equivalent IR (same jobs)", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    needs: []
    steps:
      - run: make
`;
    const yamlResult = await transform(yml, { emit: "yaml" });
    const tsResult = await transform(yml, { emit: "ts" });
    // Same IR underneath; output strings differ.
    expect(yamlResult.ir.resources.map((r) => r.logicalId)).toEqual(
      tsResult.ir.resources.map((r) => r.logicalId),
    );
  });
});
