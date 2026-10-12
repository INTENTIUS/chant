/**
 * The docker constructors take their props types (#3934). The repo typecheck
 * (scripts/typecheck.ts) compiles this file, so each `@ts-expect-error` below
 * fails it if the line it marks stops being a type error: a misspelled key or
 * a wrong-typed field must not compile. The tests themselves only run the
 * well-typed declarations.
 */

import { describe, test, expect } from "vitest";
import { Dockerfile, Service, Volume, Network, DockerConfig, DockerSecret, env } from "./index";
import type { DockerfileStep } from "./index";

describe("docker props are typed", () => {
  test("well-typed props construct", () => {
    const settings = new DockerConfig({ file: "./config/app.conf" });
    const token = new DockerSecret({ file: "./secrets/token.txt" });
    const data = new Volume({ driver: "local" });
    const backend = new Network({ internal: true });
    const app = new Dockerfile({ from: "node:20-alpine", steps: [{ workdir: "/app" }, { run: "npm ci" }] });
    const api = new Service({
      build: { context: ".", dockerfile: app },
      image: env("API_IMAGE", { default: "api:latest" }),
      ports: ["8080:8080", { target: 8080, published: "8080" }],
      configs: [{ source: settings, target: "/etc/app.conf" }],
      secrets: [token],
      networks: [backend],
      volumes: ["data:/var/lib/data"],
      depends_on: { db: { condition: "service_healthy" } },
    });
    for (const entity of [settings, token, data, backend, app, api]) {
      expect(entity).toHaveProperty("entityType");
    }
  });

  test("misspelled keys and wrong-typed fields are type errors", () => {
    // Only the type checker reads these; they are never constructed.
    const declare = (): unknown[] => [
      // @ts-expect-error `rnu` is not a Dockerfile instruction
      new Dockerfile({ from: "alpine:3.20", steps: [{ rnu: "npm ci" }] }),
      // @ts-expect-error RUN takes a string
      new Dockerfile({ from: "alpine:3.20", steps: [{ run: 42 }] }),
      // @ts-expect-error `form` is not a Dockerfile field
      new Dockerfile({ form: "alpine:3.20" }),
      // @ts-expect-error `imgae` is not a service field
      new Service({ imgae: "nginx:1.27" }),
      // @ts-expect-error `restart` is a string
      new Service({ image: "nginx:1.27", restart: 3 }),
      // @ts-expect-error `condition` is one of the wait conditions
      new Service({ depends_on: { db: { condition: "healthy" } } }),
      // @ts-expect-error `internal` is a boolean
      new Network({ internal: [] }),
      // @ts-expect-error `fiel` is not a config field
      new DockerConfig({ fiel: "./app.conf" }),
    ];
    // @ts-expect-error a step names one instruction it knows
    const step: DockerfileStep = { from: "alpine" };
    expect(typeof declare).toBe("function");
    expect(step).toBeDefined();
  });
});
