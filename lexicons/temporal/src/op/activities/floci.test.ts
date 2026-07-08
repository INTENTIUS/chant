import { describe, test, expect } from "vitest";
import {
  flociRunCommand,
  flociRmCommand,
  flociExistsCommand,
  flociHealthUrl,
  flociEnv,
  isFlociReady,
} from "./floci";

describe("flociRunCommand (#704)", () => {
  test("minimal — defaults name/port/image, no docker socket", () => {
    expect(flociRunCommand({})).toBe(
      "docker run -d --rm --name chant-floci -p 4566:4566 floci/floci:latest",
    );
  });

  test("custom name, port, and image", () => {
    const cmd = flociRunCommand({ name: "floci-e2e", port: 4599, image: "floci/floci:1.5.30" });
    expect(cmd).toContain("--name floci-e2e");
    expect(cmd).toContain("-p 4599:4566");
    expect(cmd.endsWith("floci/floci:1.5.30")).toBe(true);
  });

  test("dockerSocket mounts the socket before the image (for the ECR backing registry)", () => {
    const cmd = flociRunCommand({ dockerSocket: true });
    expect(cmd).toContain("-v /var/run/docker.sock:/var/run/docker.sock");
    // socket flag precedes the trailing image arg
    expect(cmd.indexOf("/var/run/docker.sock")).toBeLessThan(cmd.indexOf("floci/floci"));
  });
});

describe("flociRmCommand / flociExistsCommand (#704)", () => {
  test("rm force-removes the container", () => {
    expect(flociRmCommand("chant-floci")).toBe("docker rm -f chant-floci");
  });

  test("exists checks a running container by name", () => {
    expect(flociExistsCommand("chant-floci")).toBe("docker ps -q -f name=chant-floci");
  });
});

describe("flociHealthUrl / flociEnv (#704)", () => {
  test("health url targets the localstack-compatible endpoint on the host port", () => {
    expect(flociHealthUrl(4599)).toBe("http://localhost:4599/_localstack/health");
  });

  test("env points the aws CLI at the endpoint with test creds", () => {
    expect(flociEnv(4566, "us-east-1")).toEqual({
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_REGION: "us-east-1",
    });
  });
});

describe("isFlociReady (#704)", () => {
  test("true when the health body names the required service", () => {
    const body = '{"services": {"s3": "available", "cloudformation": "available"}}';
    expect(isFlociReady(body, "cloudformation")).toBe(true);
  });

  test("false before the service appears", () => {
    expect(isFlociReady('{"services": {"s3": "available"}}', "cloudformation")).toBe(false);
  });
});
