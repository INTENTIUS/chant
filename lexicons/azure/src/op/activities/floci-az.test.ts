import { describe, test, expect } from "vitest";
import {
  flociAzRunCommand,
  flociAzRmCommand,
  flociAzExistsCommand,
  flociAzHealthUrl,
  flociAzEndpoint,
} from "./floci-az";

describe("floci-az lifecycle commands (typed emulator, not shell)", () => {
  test("run command uses defaults and maps the port", () => {
    expect(flociAzRunCommand({})).toBe(
      "docker run -d --rm --name chant-floci-az -p 4577:4577 floci/floci-az:0.10.0",
    );
  });

  test("run command honors name/port/image overrides", () => {
    expect(flociAzRunCommand({ name: "az2", port: 4599, image: "floci/floci-az:0.8.0" })).toBe(
      "docker run -d --rm --name az2 -p 4599:4577 floci/floci-az:0.8.0",
    );
  });

  test("rm / exists / health / endpoint", () => {
    expect(flociAzRmCommand("az2")).toBe("docker rm -f az2");
    expect(flociAzExistsCommand("az2")).toBe("docker ps -q -f name=az2");
    expect(flociAzHealthUrl(4577)).toBe("http://localhost:4577/_floci/health");
    expect(flociAzEndpoint(4577)).toBe("http://localhost:4577");
  });
});
