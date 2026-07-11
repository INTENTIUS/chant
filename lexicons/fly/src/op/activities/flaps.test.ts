import { describe, test, expect } from "vitest";
import {
  flapsRunCommand,
  flapsRmCommand,
  flapsExistsCommand,
  flapsHealthUrl,
  flapsEndpoint,
} from "./flaps";

describe("flaps (mudflaps) lifecycle commands", () => {
  test("run command uses defaults and maps the port", () => {
    expect(flapsRunCommand({})).toBe(
      "docker run -d --rm --name chant-mudflaps -p 4280:4280 ghcr.io/intentius/mudflaps:0.3.0",
    );
  });

  test("run command honors name/port/image overrides", () => {
    expect(flapsRunCommand({ name: "mf2", port: 4599, image: "ghcr.io/intentius/mudflaps:latest" })).toBe(
      "docker run -d --rm --name mf2 -p 4599:4280 ghcr.io/intentius/mudflaps:latest",
    );
  });

  test("rm / exists / health / endpoint", () => {
    expect(flapsRmCommand("mf2")).toBe("docker rm -f mf2");
    expect(flapsExistsCommand("mf2")).toBe("docker ps -q -f name=mf2");
    expect(flapsHealthUrl(4280)).toBe("http://localhost:4280/_mudflaps/health");
    expect(flapsEndpoint(4280)).toBe("http://localhost:4280");
  });
});
