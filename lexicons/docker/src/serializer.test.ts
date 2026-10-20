import { describe, test, expect } from "vitest";
import { dockerSerializer } from "./serializer";
import { composeKey } from "./compose-key";
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

// ── Dockerfile steps ──────────────────────────────────────────────

describe("dockerSerializer.serialize — Dockerfile steps", () => {
  const dockerfile = (props: Record<string, unknown>): string => {
    const result = dockerSerializer.serialize(new Map<string, Declarable>([["app", new MockDockerfile(props)]]));
    return (result as { files: Record<string, string> }).files["Dockerfile.app"]!;
  };

  test("steps are written in the order given, interleaving COPY and RUN", () => {
    expect(dockerfile({
      from: "node:20-alpine",
      steps: [
        { workdir: "/app" },
        { copy: "package*.json ./" },
        { run: "npm ci" },
        { copy: ". ." },
        { run: "npm run build" },
        { user: "node" },
        { cmd: ["node", "dist/index.js"] },
      ],
    })).toBe([
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN npm ci",
      "COPY . .",
      "RUN npm run build",
      "USER node",
      'CMD ["node","dist/index.js"]',
      "",
    ].join("\n"));
  });

  test("every instruction is available as a step, and ARG before FROM comes from globalArgs", () => {
    expect(dockerfile({
      globalArgs: ["NODE_VERSION=20"],
      stages: [{
        from: "node:${NODE_VERSION}-alpine",
        as: "base",
        steps: [
          { shell: ["/bin/sh", "-eo", "pipefail", "-c"] },
          { arg: "APP_ENV=production" },
          { env: "NODE_ENV=$APP_ENV" },
          { label: 'org.opencontainers.image.title="app"' },
          { workdir: "/app" },
          { add: "https://example.com/a.tgz /tmp/" },
          { volume: "/data" },
          { expose: 8080 },
          { stopsignal: "SIGTERM" },
          { healthcheck: "CMD wget -qO- http://localhost:8080/health || exit 1" },
          { onbuild: "COPY . /app" },
          { entrypoint: ["/sbin/tini", "--"] },
          { cmd: "node index.js" },
        ],
      }],
    })).toBe([
      "ARG NODE_VERSION=20",
      "FROM node:${NODE_VERSION}-alpine AS base",
      'SHELL ["/bin/sh","-eo","pipefail","-c"]',
      "ARG APP_ENV=production",
      "ENV NODE_ENV=$APP_ENV",
      'LABEL org.opencontainers.image.title="app"',
      "WORKDIR /app",
      "ADD https://example.com/a.tgz /tmp/",
      "VOLUME /data",
      "EXPOSE 8080",
      "STOPSIGNAL SIGTERM",
      "HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1",
      "ONBUILD COPY . /app",
      'ENTRYPOINT ["/sbin/tini","--"]',
      "CMD node index.js",
      "",
    ].join("\n"));
  });

  test("per-kind fields keep their fixed order, byte for byte", () => {
    expect(dockerfile({
      from: "node:20-alpine",
      cmd: "node index.js",
      copy: [". ."],
      run: ["npm ci"],
      user: "node",
      workdir: "/app",
    })).toBe("FROM node:20-alpine\nWORKDIR /app\nUSER node\nRUN npm ci\nCOPY . .\nCMD node index.js\n");
  });

  test("a stage that mixes steps with per-kind fields is an error", () => {
    expect(() => dockerfile({ from: "alpine:3.20", run: ["true"], steps: [{ user: "nobody" }] }))
      .toThrow(/Dockerfile\.app: steps can't be combined with the per-kind fields \(run\)/);
    expect(() => dockerfile({ stages: [{ from: "alpine:3.20", as: "b", copy: ["a b"], steps: [] }] }))
      .toThrow(/stage "b": steps can't be combined/);
  });

  test("a step names exactly one known instruction", () => {
    expect(() => dockerfile({ from: "alpine:3.20", steps: [{ run: "a", copy: "b" }] })).toThrow(/exactly one instruction, found run, copy/);
    expect(() => dockerfile({ from: "alpine:3.20", steps: [{}] })).toThrow(/found none/);
    expect(() => dockerfile({ from: "alpine:3.20", steps: [{ from: "x" }] })).toThrow(/"from" is not a Dockerfile instruction a step can name/);
    expect(() => dockerfile({ from: "alpine:3.20", steps: [{ copy: ["a", "b"] }] })).toThrow(/COPY takes a string/);
  });

  test("steps on the Dockerfile itself with stages is an error", () => {
    expect(() => dockerfile({ stages: [{ from: "alpine:3.20" }], steps: [{ run: "true" }] })).toThrow(/steps belongs on each stage/);
  });

  test("stages and step lists are plain values that can be shared and spread", () => {
    const install = [{ copy: "package*.json ./" }, { run: "npm ci" }];
    const base = { from: "node:20-alpine", as: "deps", steps: [{ workdir: "/app" }, ...install] };
    expect(dockerfile({ stages: [base, { from: "node:20-alpine", steps: [{ copy: "--from=deps /app/node_modules ./node_modules" }] }] }))
      .toBe("FROM node:20-alpine AS deps\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nFROM node:20-alpine\nCOPY --from=deps /app/node_modules ./node_modules\n");
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

describe("composeKey (#3937)", () => {
  test("the entity takes the key, and a reference to it serializes as the key", () => {
    const data = composeKey("app-data", new MockVolume({ driver: "local" }));
    const out = dockerSerializer.serialize(new Map<string, Declarable>([
      ["web", composeKey("web-app", new MockService({ image: "nginx", volumes: [data] }))],
      ["appData", data],
    ])) as string;
    expect(out).toContain("  web-app:\n");
    expect(out).toContain("  app-data:\n");
    expect(out).toContain("      - app-data\n");
    expect(out).not.toContain("appData");
  });

  test("two entities of one kind with the same key is an error", () => {
    expect(() => dockerSerializer.serialize(new Map<string, Declarable>([
      ["db", new MockService({ image: "postgres" })],
      ["primary", composeKey("db", new MockService({ image: "postgres" }))],
    ]))).toThrow('docker: db and primary both take the compose key "db"');
  });

  test("a service and a volume may share a key", () => {
    const out = dockerSerializer.serialize(new Map<string, Declarable>([
      ["db", new MockService({ image: "postgres" })],
      ["dbVolume", composeKey("db", new MockVolume({}))],
    ])) as string;
    expect(out).toContain("services:\n  db:\n");
    expect(out).toContain("volumes:\n  db:");
  });
});
