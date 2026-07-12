import { describe, it, expect } from "vitest";
import { flyContextTools, imagePinned } from "./context-tools";

describe("flyContextTools", () => {
  const tools = flyContextTools();

  it("exposes the read-only fly:* context tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["fly:app", "fly:checks", "fly:plan", "fly:references"]);
  });

  it("every tool has a description, a path input, and a handler", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toHaveProperty("path");
      expect(typeof t.handler).toBe("function");
    }
  });
});

describe("imagePinned", () => {
  it("is pinned only when the image names a digest", () => {
    expect(imagePinned("flyio/hellofly@sha256:abc123")).toBe(true);
    expect(imagePinned("flyio/hellofly:latest")).toBe(false);
    expect(imagePinned("flyio/hellofly")).toBe(false);
  });
});
