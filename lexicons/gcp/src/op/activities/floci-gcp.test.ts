import { describe, test, expect } from "vitest";
import {
  flociGcpRunCommand,
  flociGcpRmCommand,
  flociGcpExistsCommand,
  flociGcpHealthUrl,
  flociGcpEndpoint,
} from "./floci-gcp";

describe("floci-gcp lifecycle commands (typed emulator, not shell)", () => {
  test("run command uses defaults and maps the port", () => {
    expect(flociGcpRunCommand({})).toBe(
      "docker run -d --rm --name chant-floci-gcp -p 4588:4588 floci/floci-gcp:latest",
    );
  });

  test("run command honors name/port/image overrides", () => {
    expect(flociGcpRunCommand({ name: "gcp2", port: 4599, image: "floci/floci-gcp:0.4.0" })).toBe(
      "docker run -d --rm --name gcp2 -p 4599:4588 floci/floci-gcp:0.4.0",
    );
  });

  test("rm / exists / health / endpoint", () => {
    expect(flociGcpRmCommand("gcp2")).toBe("docker rm -f gcp2");
    expect(flociGcpExistsCommand("gcp2")).toBe("docker ps -q -f name=gcp2");
    expect(flociGcpHealthUrl(4588)).toBe("http://localhost:4588/_floci-gcp/health");
    expect(flociGcpEndpoint(4588)).toBe("http://localhost:4588");
  });
});
