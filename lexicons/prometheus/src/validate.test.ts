import { describe, expect, test } from "vitest";
import { validate } from "./validate";
import { hasTool } from "./tools";

const PROMTOOL = hasTool(process.env.PROMTOOL ?? "promtool");

describe("the lexicon's validate()", () => {
  test("passes, and says whether promtool check config ran", async () => {
    const result = await validate();
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.success).toBe(true);
    const check = result.checks.find((c) => c.name.startsWith("promtool-check-config"));
    expect(check).toBeDefined();
    if (PROMTOOL) expect(check!.name).toBe("promtool-check-config");
    else expect(check!.name).toContain("skipped");
  });
});
