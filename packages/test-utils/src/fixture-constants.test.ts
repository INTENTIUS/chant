import { describe, it, expect } from "bun:test";
import { FIXTURE } from "./fixture-constants";

describe("FIXTURE", () => {
  it("has all required keys", () => {
    expect(FIXTURE.lexicon).toBe("testdom");
    expect(FIXTURE.namespace).toBe("TST");
    expect(FIXTURE.entityType).toBe("TestDom::Storage::Bucket");
    expect(FIXTURE.packageName).toBe("@intentius/chant-lexicon-testdom");
    expect(FIXTURE.lexiconJsonFilename).toBe("lexicon-testdom.json");
  });
});
