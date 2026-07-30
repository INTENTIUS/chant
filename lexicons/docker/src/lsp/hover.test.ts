import { describe, test, expect } from "vitest";
import { dockerHover } from "./hover";
import type { HoverContext } from "@intentius/chant/lsp/types";

// Same correction as completions.test.ts: the old shape (word / fileContent /
// position) no longer matches HoverContext, and the assertions were written to
// pass either way ("undefined or an object", "if result !== undefined"), so a
// hover that returned nothing at all still looked healthy.
function ctx(word: string): HoverContext {
  return {
    uri: "file:///infra.ts",
    content: "",
    position: { line: 0, character: 0 },
    word,
    lineText: "",
  };
}

describe("dockerHover", () => {
  test("returns undefined for an unknown word", () => {
    expect(dockerHover(ctx("NotADockerThing"))).toBeUndefined();
    expect(dockerHover(ctx(""))).toBeUndefined();
  });

  test("describes a known resource with its docker type", () => {
    const info = dockerHover(ctx("Service"));

    expect(info?.contents).toContain("**Service**");
    expect(info?.contents).toContain("Docker::Compose::Service");
  });

  test("notes which artifact a resource serializes into", () => {
    expect(dockerHover(ctx("Service"))?.contents).toContain("docker-compose.yml");
  });
});
