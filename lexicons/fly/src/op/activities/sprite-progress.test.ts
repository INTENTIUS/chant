import { describe, test, expect, vi, afterEach } from "vitest";
import { spriteCreate, type SpritesHttp } from "./sprites";
import { spriteApplyServices } from "./sprite-config";

/**
 * #3200: an Op step's stdout is its output, so the Sprites activities write
 * progress to stderr (as the Machines applier does since #2516) and leave
 * stdout clean.
 */
describe("Sprites activities keep stdout clean (#3200)", () => {
  afterEach(() => vi.restoreAllMocks());

  test("create and services apply write progress to stderr only", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    const http: SpritesHttp = async (method, url) => {
      if (method === "POST" && url.endsWith("/v1/sprites")) return { status: 200, text: JSON.stringify({ id: "box-1", url: "https://box-1.sprites.app" }) };
      if (method === "GET" && url.endsWith("/services")) return { status: 200, text: "[]" };
      return { status: 200, text: "{}" };
    };
    const endpoint = "http://localhost:4290";

    const created = await spriteCreate({ name: "box-1", endpoint }, undefined, http);
    const applied = await spriteApplyServices(
      {
        id: "box-1",
        endpoint,
        start: true,
        services: [
          { name: "db", cmd: "postgres" },
          { name: "web", cmd: "node server.js", needs: ["db"] },
        ],
      },
      undefined,
      http,
    );

    expect(created.id).toBe("box-1");
    expect(applied.started).toEqual(["db", "web"]);
    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const err = stderr.join("");
    expect(err).toMatch(/created: sprite\/box-1/);
    expect(err).toMatch(/services: sprite\/box-1 applied 2\/2/);
    expect(err).toMatch(/services: sprite\/box-1 started 2 in dependency order/);
  });
});
