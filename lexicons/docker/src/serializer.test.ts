import { describe, test, expect } from "vitest";
import { dockerSerializer } from "./serializer";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

// ── Mock entities ──────────────────────────────────────────────────

class MockService implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "docker";
  readonly entityType = "Docker::Compose::Service";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockVolume implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "docker";
  readonly entityType = "Docker::Compose::Volume";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockNetwork implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "docker";
  readonly entityType = "Docker::Compose::Network";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockDockerfile implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "docker";
  readonly entityType = "Docker::Dockerfile";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockPropertyDeclarable implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "docker";
  readonly entityType = "Docker::Compose::HealthCheck";
  readonly kind = "property" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

class MockDefaultLabels implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly [Symbol.for("docker.defaultLabels")] = true as const;
  readonly lexicon = "docker";
  readonly entityType = "Docker::DefaultLabels";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

// ── Identity tests ─────────────────────────────────────────────────

describe("dockerSerializer", () => {
  test("has correct name", () => {
    expect(dockerSerializer.name).toBe("docker");
  });

  test("has correct rulePrefix", () => {
    expect(dockerSerializer.rulePrefix).toBe("DKR");
  });
});

// ── Empty input ────────────────────────────────────────────────────

describe("dockerSerializer.serialize — empty", () => {
  test("returns newline for empty entities", () => {
    const output = dockerSerializer.serialize(new Map());
    expect(output).toBe("\n");
  });
});

// ── Single service ─────────────────────────────────────────────────

describe("dockerSerializer.serialize — single service", () => {
  test("serializes one service with image", () => {
    const entities = new Map<string, Declarable>();
    entities.set("api", new MockService({ image: "nginx:1.25" }));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).toContain("services:");
    expect(output).toContain("api:");
    expect(output).toContain("image: nginx:1.25");
  });

  test("omits null/undefined properties", () => {
    const entities = new Map<string, Declarable>();
    entities.set("api", new MockService({ image: "nginx", restart: undefined }));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).not.toContain("restart:");
  });

  test("emits short-form depends_on (list)", () => {
    const entities = new Map<string, Declarable>();
    entities.set("api", new MockService({ image: "nginx", depends_on: ["db"] }));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).toContain("depends_on:");
    expect(output).toContain("- db");
  });

  test("emits long-form depends_on with a wait condition", () => {
    const entities = new Map<string, Declarable>();
    entities.set(
      "api",
      new MockService({
        image: "nginx",
        depends_on: { db: { condition: "service_healthy" } },
      }),
    );

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).toContain("depends_on:");
    expect(output).toContain("db:");
    expect(output).toContain("condition: service_healthy");
  });
});

// ── Multi-resource ────────────────────────────────────────────────

describe("dockerSerializer.serialize — multi-resource", () => {
  test("serializes services, volumes, networks in order", () => {
    const entities = new Map<string, Declarable>();
    entities.set("api", new MockService({ image: "myapp:latest" }));
    entities.set("data", new MockVolume({}));
    entities.set("frontend", new MockNetwork({}));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).toContain("services:");
    expect(output).toContain("volumes:");
    expect(output).toContain("networks:");

    const servicesIdx = output.indexOf("services:");
    const volumesIdx = output.indexOf("volumes:");
    const networksIdx = output.indexOf("networks:");
    expect(servicesIdx).toBeLessThan(volumesIdx);
    expect(volumesIdx).toBeLessThan(networksIdx);
  });
});

// ── Dockerfile emission ───────────────────────────────────────────

describe("dockerSerializer.serialize — Dockerfile", () => {
  test("emits Dockerfile.{name} in SerializerResult", () => {
    const entities = new Map<string, Declarable>();
    entities.set("api", new MockService({ image: "myapp:latest" }));
    entities.set("api", new MockService({
      build: { dockerfile: "Dockerfile.builder" },
    }));
    entities.set("builder", new MockDockerfile({
      from: "node:20-alpine",
      run: ["npm ci", "npm run build"],
      cmd: `["node", "dist/index.js"]`,
    }));

    const output = dockerSerializer.serialize(entities);
    expect(typeof output).toBe("object");
    const result = output as { primary: string; files: Record<string, string> };
    expect(result.files).toBeDefined();
    expect(result.files["Dockerfile.builder"]).toBeDefined();
    expect(result.files["Dockerfile.builder"]).toContain("FROM node:20-alpine");
    expect(result.files["Dockerfile.builder"]).toContain("RUN npm ci");
  });

  test("primary contains compose YAML when Dockerfile present", () => {
    const entities = new Map<string, Declarable>();
    entities.set("web", new MockService({ image: "nginx" }));
    entities.set("builder", new MockDockerfile({ from: "node:20" }));

    const result = dockerSerializer.serialize(entities) as { primary: string; files: Record<string, string> };
    expect(result.primary).toContain("services:");
    expect(result.primary).toContain("web:");
  });

  test("returns string (no SerializerResult) when no Dockerfile entities", () => {
    const entities = new Map<string, Declarable>();
    entities.set("web", new MockService({ image: "nginx" }));

    const output = dockerSerializer.serialize(entities);
    expect(typeof output).toBe("string");
  });
});

// ── Default labels ────────────────────────────────────────────────

describe("dockerSerializer.serialize — default labels", () => {
  test("merges default labels into every service", () => {
    const entities = new Map<string, Declarable>();
    entities.set("labels", new MockDefaultLabels({ labels: { "app.team": "platform" } }));
    entities.set("api", new MockService({ image: "myapp:1.0" }));
    entities.set("worker", new MockService({ image: "myworker:1.0" }));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).toContain("app.team: platform");
  });

  test("default labels are not emitted as a top-level key", () => {
    const entities = new Map<string, Declarable>();
    entities.set("labels", new MockDefaultLabels({ labels: { "app.team": "platform" } }));
    entities.set("api", new MockService({ image: "myapp:1.0" }));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).not.toContain("Docker::DefaultLabels");
  });
});

// ── Property kind skipping ─────────────────────────────────────────

describe("dockerSerializer.serialize — property skipping", () => {
  test("skips entities with kind=property", () => {
    const entities = new Map<string, Declarable>();
    entities.set("api", new MockService({ image: "myapp:1.0" }));
    entities.set("hc", new MockPropertyDeclarable({ test: "curl -f http://localhost" }));

    const output = dockerSerializer.serialize(entities) as string;
    // Property entities should not appear as top-level services
    expect(output).not.toContain("Docker::Compose::HealthCheck");
  });
});

// ── Key order ────────────────────────────────────────────────────

describe("dockerSerializer.serialize — key order", () => {
  test("services appears before volumes appears before networks", () => {
    const entities = new Map<string, Declarable>();
    entities.set("net", new MockNetwork({ driver: "bridge" }));
    entities.set("vol", new MockVolume({ driver: "local" }));
    entities.set("svc", new MockService({ image: "nginx" }));

    const output = dockerSerializer.serialize(entities) as string;
    const svcIdx = output.indexOf("services:");
    const volIdx = output.indexOf("volumes:");
    const netIdx = output.indexOf("networks:");

    expect(svcIdx).toBeLessThan(volIdx);
    expect(volIdx).toBeLessThan(netIdx);
  });
});

// ── Intrinsic serialization ───────────────────────────────────────

describe("dockerSerializer.serialize — intrinsics", () => {
  test("serializes env() intrinsic to ${VAR} string", () => {
    const mockEnvIntrinsic = {
      [INTRINSIC_MARKER]: true,
      toJSON: () => "${APP_IMAGE:-myapp:latest}",
      toString: () => "${APP_IMAGE:-myapp:latest}",
    };

    const entities = new Map<string, Declarable>();
    entities.set("api", new MockService({ image: mockEnvIntrinsic }));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).toContain("${APP_IMAGE:-myapp:latest}");
  });
});

// ── Multi-stage Dockerfile ────────────────────────────────────────

describe("dockerSerializer.serialize — multi-stage Dockerfile", () => {
  test("emits multiple FROM instructions for stages", () => {
    const entities = new Map<string, Declarable>();
    entities.set("app", new MockDockerfile({
      stages: [
        { from: "node:20-alpine", as: "builder", run: ["npm ci", "npm run build"] },
        { from: "nginx:alpine", copy: ["--from=builder /app/dist /usr/share/nginx/html"] },
      ],
    }));

    const output = dockerSerializer.serialize(entities);
    const result = output as { primary: string; files: Record<string, string> };
    const dockerfile = result.files["Dockerfile.app"];
    expect(dockerfile).toContain("FROM node:20-alpine AS builder");
    expect(dockerfile).toContain("FROM nginx:alpine");
    expect(dockerfile).toContain("RUN npm ci");
  });
});

// ── Name generation ───────────────────────────────────────────────

describe("dockerSerializer.serialize — name gen", () => {
  test("uses export name as service key", () => {
    const entities = new Map<string, Declarable>();
    entities.set("myWebServer", new MockService({ image: "nginx" }));

    const output = dockerSerializer.serialize(entities) as string;
    expect(output).toContain("myWebServer:");
  });
});

// ── Telemetry attribution (#2558, D22) ─────────────────────────────

describe("telemetry attribution", () => {
  const run = (props: Record<string, unknown>, telemetry?: { workspace?: string; member?: string; environment?: string }) => {
    const result = dockerSerializer.serialize(new Map([["api", new MockService(props)]]), [], telemetry ? { telemetry } : undefined);
    return typeof result === "string" ? result : result.primary;
  };
  const attrs = { workspace: "acme", member: "delivery", environment: "prod" };

  test("a build with no telemetry context is the same bytes as one that passes an empty context", () => {
    const props = { image: "nginx:1" };
    expect(run(props)).toBe(dockerSerializer.serialize(new Map([["api", new MockService(props)]]), [], {}) as string);
    expect(run(props)).not.toContain("OTEL_");
  });

  test("stamps the service name and the resource attributes into the environment", () => {
    const out = run({ image: "nginx:1" }, attrs);
    expect(out).toContain("OTEL_SERVICE_NAME: api");
    expect(out).toContain("OTEL_RESOURCE_ATTRIBUTES: chant.workspace=acme,chant.member=delivery,chant.decl=api,deployment.environment.name=prod");
  });

  test("leaves out an attribute the build does not know", () => {
    const out = run({ image: "nginx:1" }, { workspace: "acme" });
    expect(out).toContain("OTEL_RESOURCE_ATTRIBUTES: chant.workspace=acme,chant.decl=api");
    expect(out).not.toContain("chant.member");
    expect(out).not.toContain("deployment.environment.name");
  });

  test("stamps service.version when the image is pinned by digest", () => {
    const out = run({ image: "ghcr.io/acme/api@sha256:abc123" }, attrs);
    expect(out).toContain("service.version=sha256%3Aabc123");
  });

  test("keeps the keys a map environment already sets and appends the missing attributes", () => {
    const out = run({ image: "x", environment: { OTEL_SERVICE_NAME: "checkout", OTEL_RESOURCE_ATTRIBUTES: "chant.member=mine,team=pay", PORT: "80" } }, attrs);
    expect(out).toContain("OTEL_SERVICE_NAME: checkout");
    expect(out).toContain("OTEL_RESOURCE_ATTRIBUTES: chant.member=mine,team=pay,chant.workspace=acme,chant.decl=api,deployment.environment.name=prod");
    expect(out).toContain("PORT:");
  });

  test("adds the variables to a list environment, keeping an entry already there", () => {
    const out = run({ image: "x", environment: ["PORT=80", "OTEL_SERVICE_NAME=checkout"] }, attrs);
    expect(out).toContain("- PORT=80");
    expect(out).toContain("- OTEL_SERVICE_NAME=checkout");
    expect(out).not.toContain("OTEL_SERVICE_NAME=api");
    expect(out).toContain("- OTEL_RESOURCE_ATTRIBUTES=chant.workspace=acme,chant.member=delivery");
  });

  test("the resource attributes end with the release reference a deploy fills, once (#3061)", () => {
    expect(run({ image: "nginx:1" }, attrs)).toContain(
      "OTEL_RESOURCE_ATTRIBUTES: chant.workspace=acme,chant.member=delivery,chant.decl=api,deployment.environment.name=prod${CHANT_RELEASE_ATTRIBUTES:-}",
    );
    const own = run({ image: "x", environment: { OTEL_RESOURCE_ATTRIBUTES: "team=pay${CHANT_RELEASE_ATTRIBUTES:-}" } }, { workspace: "acme" });
    expect(own.match(/CHANT_RELEASE_ATTRIBUTES/g)).toHaveLength(1);
    expect(run({ image: "x", environment: ["OTEL_RESOURCE_ATTRIBUTES=team=pay"] }, { workspace: "acme" })).toContain(
      "- OTEL_RESOURCE_ATTRIBUTES=team=pay,chant.workspace=acme,chant.decl=api${CHANT_RELEASE_ATTRIBUTES:-}",
    );
  });
});
