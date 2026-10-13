import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant";
import { DockerWebService } from "./docker-web-service";

const props = (s: unknown) => (s as { props: Record<string, unknown> }).props;

describe("DockerWebService", () => {
  test("one Compose service, keyed by the export name plus Service", () => {
    const expanded = expandComposite("app", DockerWebService({ build: { context: "../app" }, port: 8080 }));
    expect([...expanded.keys()]).toEqual(["appService"]);
    expect(expanded.get("appService")?.entityType).toBe("Docker::Compose::Service");
  });

  test("builds from the Dockerfile, publishes the port, passes it as PORT, and checks the health path", () => {
    const { service } = DockerWebService({ build: { context: "../app" }, image: "app:local", port: 8080, healthPath: "/healthz" }).members;
    expect(props(service)).toEqual({
      build: { context: "../app", dockerfile: "Dockerfile" },
      image: "app:local",
      ports: ["8080:8080"],
      environment: { PORT: "8080" },
      restart: "unless-stopped",
      healthcheck: { test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"], interval: "30s", timeout: "5s", retries: 3 },
    });
  });

  test("an image alone, another host port, extra environment, and no health check without a path", () => {
    const { service } = DockerWebService({ image: "nginx:1", port: 80, hostPort: 8081, environment: { MODE: "prod" } }).members;
    expect(props(service)).toEqual({ image: "nginx:1", ports: ["8081:80"], environment: { PORT: "80", MODE: "prod" }, restart: "unless-stopped" });
  });

  test("needs a build or an image", () => {
    expect(() => DockerWebService({ port: 8080 })).toThrow(/give `build`, `image`, or both/);
  });
});
