import { describe, test, expect } from "vitest";
import {
  flociGcpRunCommand,
  flociGcpRmCommand,
  flociGcpExistsCommand,
  flociGcpHealthUrl,
  flociGcpEndpoint,
  FLOCI_GCP_EMULATOR,
} from "./floci-gcp";
import { endpointEnvVars } from "@intentius/chant/op";

describe("floci-gcp lifecycle commands (typed emulator, not shell)", () => {
  test("run command uses defaults and maps the port", () => {
    expect(flociGcpRunCommand({})).toBe(
      "docker run -d --rm --name chant-floci-gcp -p 4588:4588 floci/floci-gcp:0.5.0",
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

describe("floci-gcp emulator capability (#1431)", () => {
  // The bug: `env` returned {}, so `chant emulator up --lexicon gcp` booted the
  // emulator and left GCP_ENDPOINT_URL unset — pointing describeResources and
  // observeResourcesDeep, which read that variable and nothing else, at real GCP.
  test("injects the endpoint under the variable the READ path honours", () => {
    expect(FLOCI_GCP_EMULATOR.env("http://localhost:4588")).toEqual({
      GCP_ENDPOINT_URL: "http://localhost:4588",
    });
  });

  test("injects whatever endpoint it is given, not a hardcoded port", () => {
    expect(FLOCI_GCP_EMULATOR.env("http://localhost:4599")).toEqual({
      GCP_ENDPOINT_URL: "http://localhost:4599",
    });
  });

  // `endpointEnvVars` derives its list by probing `env`, so an empty `env` also
  // meant core believed gcp had no endpoint variable at all.
  test("core can now derive gcp's endpoint variable from the capability", () => {
    expect(endpointEnvVars(FLOCI_GCP_EMULATOR)).toEqual(["GCP_ENDPOINT_URL"]);
  });
});
