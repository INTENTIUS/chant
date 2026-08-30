import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { postSynthChecks } from "./index";
import { parseCpuMillicores, parseMemoryMib, imageTag, parseLink } from "./helpers";

/**
 * Build a context from plain objects.
 *
 * The checks read `ctx.entities` through `propsOf`, which handles both a real
 * runtime instance and a plain object — so fixtures stay readable and still
 * exercise the same path a build does.
 */
function ctx(entities: Record<string, { entityType: string; props: Record<string, unknown> }>): PostSynthContext {
  const map = new Map<string, Declarable>(Object.entries(entities) as unknown as Array<[string, Declarable]>);
  return {
    outputs: new Map(),
    entities: map,
    buildResult: { outputs: new Map(), entities: map, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const workload = (props: Record<string, unknown>) => ({ entityType: "Cpln::Core::Workload", props });
const gvc = (props: Record<string, unknown>) => ({ entityType: "Cpln::Core::Gvc", props });
const policy = (props: Record<string, unknown>) => ({ entityType: "Cpln::Core::Policy", props });
const domain = (props: Record<string, unknown>) => ({ entityType: "Cpln::Core::Domain", props });
const volumeSet = (props: Record<string, unknown>) => ({ entityType: "Cpln::Core::VolumeSet", props });

/** Run one check by id and return its diagnostics. */
function run(id: string, context: PostSynthContext) {
  const check = postSynthChecks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check.check(context);
}

/** Run every check — used to assert a fixture is clean overall. */
function runAll(context: PostSynthContext) {
  return postSynthChecks.flatMap((check) => check.check(context));
}

describe("post-synth check registry", () => {
  it("registers at least 15 checks with unique ids", () => {
    expect(postSynthChecks.length).toBeGreaterThanOrEqual(15);
    const ids = postSynthChecks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every check a description", () => {
    for (const check of postSynthChecks) expect(check.description.length).toBeGreaterThan(0);
  });

  it("reports nothing for an empty build", () => {
    expect(runAll(ctx({}))).toEqual([]);
  });
});

describe("CPL010 unrestricted outbound", () => {
  it("flags outbound 0.0.0.0/0", () => {
    const found = run(
      "CPL010",
      ctx({ web: workload({ spec: { firewallConfig: { external: { outboundAllowCIDR: ["0.0.0.0/0"] } } } }) }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
  });

  it("leaves inbound 0.0.0.0/0 alone — that is how a public service is written", () => {
    const found = run(
      "CPL010",
      ctx({ web: workload({ spec: { firewallConfig: { external: { inboundAllowCIDR: ["0.0.0.0/0"] } } } }) }),
    );
    expect(found).toEqual([]);
  });
});

describe("CPL011 internal firewall scope", () => {
  it("flags same-org", () => {
    const found = run(
      "CPL011",
      ctx({ web: workload({ spec: { firewallConfig: { internal: { inboundAllowType: "same-org" } } } }) }),
    );
    expect(found).toHaveLength(1);
  });

  it("accepts same-gvc", () => {
    expect(
      run("CPL011", ctx({ web: workload({ spec: { firewallConfig: { internal: { inboundAllowType: "same-gvc" } } } }) })),
    ).toEqual([]);
  });
});

describe("CPL012 literal credentials in env", () => {
  const withEnv = (env: Array<{ name: string; value: string }>) =>
    ctx({ web: workload({ spec: { containers: [{ name: "main", env }] } }) });

  it("flags a credential-named var set to a literal", () => {
    const found = run("CPL012", withEnv([{ name: "DB_PASSWORD", value: "hunter2" }]));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
  });

  it("accepts a secret reference", () => {
    expect(run("CPL012", withEnv([{ name: "DB_PASSWORD", value: "cpln://secret/db.payload" }]))).toEqual([]);
  });

  it("accepts an obvious placeholder", () => {
    expect(run("CPL012", withEnv([{ name: "API_TOKEN", value: "changeme" }]))).toEqual([]);
  });

  it("ignores a var that is not credential-shaped", () => {
    expect(run("CPL012", withEnv([{ name: "LOG_LEVEL", value: "debug" }]))).toEqual([]);
  });
});

describe("CPL013 identity principal qualification", () => {
  it("flags the bare //identity/NAME form", () => {
    const found = run(
      "CPL013",
      ctx({ p: policy({ bindings: [{ permissions: ["reveal"], principalLinks: ["//identity/api"] }] }) }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("//gvc/<gvc>/identity/api");
  });

  it("accepts the GVC-qualified form", () => {
    expect(
      run(
        "CPL013",
        ctx({ p: policy({ bindings: [{ permissions: ["reveal"], principalLinks: ["//gvc/prod/identity/api"] }] }) }),
      ),
    ).toEqual([]);
  });

  it("leaves other principal types alone", () => {
    expect(
      run("CPL013", ctx({ p: policy({ bindings: [{ principalLinks: ["//user/a@b.com", "//group/devs"] }] }) })),
    ).toEqual([]);
  });
});

describe("CPL014 secret reference field qualifier", () => {
  const withEnv = (value: string) =>
    ctx({ web: workload({ spec: { containers: [{ name: "main", env: [{ name: "X", value }] }] } }) });

  it("flags an unqualified reference", () => {
    const found = run("CPL014", withEnv("cpln://secret/db"));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("cpln://secret/db.FIELD");
  });

  it("accepts a qualified reference", () => {
    expect(run("CPL014", withEnv("cpln://secret/db.payload"))).toEqual([]);
  });
});

describe("CPL020 serverless port count", () => {
  it("flags zero ports", () => {
    const found = run("CPL020", ctx({ web: workload({ spec: { type: "serverless", containers: [{ name: "m" }] } }) }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("serve nothing");
  });

  it("flags two ports", () => {
    const found = run(
      "CPL020",
      ctx({
        web: workload({
          spec: {
            type: "serverless",
            containers: [{ name: "m", ports: [{ number: 8080 }, { number: 9090 }] }],
          },
        }),
      }),
    );
    expect(found).toHaveLength(1);
  });

  it("flags a non-HTTP port", () => {
    const found = run(
      "CPL020",
      ctx({
        web: workload({
          spec: { type: "serverless", containers: [{ name: "m", ports: [{ number: 5432, protocol: "tcp" }] }] },
        }),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("only http");
  });

  it("accepts exactly one HTTP port", () => {
    expect(
      run(
        "CPL020",
        ctx({
          web: workload({
            spec: { type: "serverless", containers: [{ name: "m", ports: [{ number: 8080, protocol: "http" }] }] },
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("defaults an unset type to serverless", () => {
    // Control Plane's own default, so a workload with no `type` is checked as
    // what it will actually become.
    expect(run("CPL020", ctx({ web: workload({ spec: { containers: [{ name: "m" }] } }) }))).toHaveLength(1);
  });
});

describe("CPL021 cron shape", () => {
  it("flags a cron workload with no schedule", () => {
    const found = run("CPL021", ctx({ job: workload({ spec: { type: "cron" } }) }));
    expect(found.some((d) => d.message.includes("no spec.job.schedule"))).toBe(true);
  });

  it("flags a cron workload exposing ports", () => {
    const found = run(
      "CPL021",
      ctx({
        job: workload({
          spec: { type: "cron", job: { schedule: "0 * * * *" }, containers: [{ name: "m", ports: [{ number: 80 }] }] },
        }),
      }),
    );
    expect(found.some((d) => d.message.includes("cannot serve traffic"))).toBe(true);
  });

  it("flags spec.job on a non-cron workload", () => {
    const found = run("CPL021", ctx({ web: workload({ spec: { type: "standard", job: { schedule: "* * * * *" } } }) }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("Only cron");
  });

  it("accepts a well-formed cron workload", () => {
    expect(
      run("CPL021", ctx({ job: workload({ spec: { type: "cron", job: { schedule: "0 * * * *" } } }) })),
    ).toEqual([]);
  });
});

describe("CPL022 container ports", () => {
  it("flags port and ports together", () => {
    const found = run(
      "CPL022",
      ctx({ web: workload({ spec: { containers: [{ name: "m", port: 80, ports: [{ number: 80 }] }] } }) }),
    );
    expect(found.some((d) => d.message.includes("mutually exclusive"))).toBe(true);
  });

  it("flags a port number reused across containers", () => {
    const found = run(
      "CPL022",
      ctx({
        web: workload({
          spec: {
            containers: [
              { name: "a", ports: [{ number: 8080 }] },
              { name: "b", ports: [{ number: 8080 }] },
            ],
          },
        }),
      }),
    );
    expect(found.some((d) => d.message.includes("both"))).toBe(true);
  });
});

describe("CPL023 container resources", () => {
  const container = (props: Record<string, unknown>) =>
    ctx({ web: workload({ spec: { containers: [{ name: "m", ...props }] } }) });

  it("flags CPU below the floor", () => {
    expect(run("CPL023", container({ cpu: "10m", memory: "32Mi" })).some((d) => d.message.includes("minimum is 25m"))).toBe(
      true,
    );
  });

  it("flags a memory-to-CPU ratio above 8", () => {
    const found = run("CPL023", container({ cpu: "50m", memory: "2Gi" }));
    expect(found.some((d) => d.message.includes("memory-to-CPU ratio"))).toBe(true);
    expect(found.find((d) => d.message.includes("ratio"))!.message).toContain("256m");
  });

  it("honours the relax tag", () => {
    const relaxed = ctx({
      web: workload({
        tags: { "cpln/relaxMemoryToCpuRatio": "true" },
        spec: { containers: [{ name: "m", cpu: "100m", memory: "2Gi" }] },
      }),
    });
    expect(run("CPL023", relaxed)).toEqual([]);
  });

  it("accepts the platform defaults", () => {
    // 128Mi / 50m = 2.56, comfortably under the ceiling.
    expect(run("CPL023", container({}))).toEqual([]);
  });
});

describe("CPL024 probe handlers", () => {
  const probe = (readinessProbe: Record<string, unknown>) =>
    ctx({ web: workload({ spec: { containers: [{ name: "m", readinessProbe }] } }) });

  it("flags a probe with no handler", () => {
    const found = run("CPL024", probe({ initialDelaySeconds: 5 }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("checks nothing");
  });

  it("flags two handlers", () => {
    const found = run("CPL024", probe({ httpGet: { path: "/" }, tcpSocket: { port: 80 } }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("mutually exclusive");
  });

  it("accepts exactly one", () => {
    expect(run("CPL024", probe({ httpGet: { path: "/healthz" } }))).toEqual([]);
  });
});

describe("CPL025 autoscaling shape", () => {
  const scaling = (autoscaling: Record<string, unknown>, type = "standard") =>
    ctx({ web: workload({ spec: { type, defaultOptions: { autoscaling } } }) });

  it("flags metric with multi", () => {
    expect(
      run("CPL025", scaling({ metric: "cpu", multi: [{ metric: "cpu" }] })).some((d) =>
        d.message.includes("mutually exclusive"),
      ),
    ).toBe(true);
  });

  it("flags target above 100 with cpu", () => {
    expect(run("CPL025", scaling({ metric: "cpu", target: 150 })).some((d) => d.message.includes("capped at 100"))).toBe(
      true,
    );
  });

  it("flags a metric the workload type does not support", () => {
    expect(
      run("CPL025", scaling({ metric: "concurrency" }, "standard")).some((d) => d.message.includes("does not support")),
    ).toBe(true);
  });

  it("flags multi-metric on serverless", () => {
    expect(
      run("CPL025", scaling({ multi: [{ metric: "cpu" }] }, "serverless")).some((d) =>
        d.message.includes("standard and stateful"),
      ),
    ).toBe(true);
  });
});

describe("CPL026 scale to zero", () => {
  it("flags minScale 0 on serverless with cpu", () => {
    const found = run(
      "CPL026",
      ctx({ web: workload({ spec: { type: "serverless", defaultOptions: { autoscaling: { minScale: 0, metric: "cpu" } } } }) }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("holds at one replica");
  });

  it("accepts minScale 0 on serverless with concurrency", () => {
    expect(
      run(
        "CPL026",
        ctx({
          web: workload({
            spec: { type: "serverless", defaultOptions: { autoscaling: { minScale: 0, metric: "concurrency" } } },
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("accepts minScale 0 on standard under KEDA", () => {
    expect(
      run(
        "CPL026",
        ctx({
          web: workload({
            spec: { type: "standard", defaultOptions: { autoscaling: { minScale: 0, metric: "keda" } } },
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("flags minScale 0 on cron outright", () => {
    const found = run(
      "CPL026",
      ctx({ job: workload({ spec: { type: "cron", defaultOptions: { autoscaling: { minScale: 0 } } } }) }),
    );
    expect(found[0].severity).toBe("error");
  });
});

describe("CPL027 Capacity AI conflicts", () => {
  it("flags CPU autoscaling under the default-on Capacity AI", () => {
    const found = run(
      "CPL027",
      ctx({ web: workload({ spec: { type: "standard", defaultOptions: { autoscaling: { metric: "cpu" } } } }) }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("on by default");
  });

  it("says so differently when Capacity AI is declared", () => {
    const found = run(
      "CPL027",
      ctx({
        web: workload({
          spec: { type: "standard", defaultOptions: { capacityAI: true, autoscaling: { metric: "cpu" } } },
        }),
      }),
    );
    expect(found[0].message).not.toContain("on by default");
  });

  it("flags a GPU", () => {
    const found = run(
      "CPL027",
      ctx({ web: workload({ spec: { type: "standard", containers: [{ name: "m", gpu: { nvidia: {} } }] } }) }),
    );
    expect(found.some((d) => d.message.includes("GPU"))).toBe(true);
  });

  it("accepts the conflict once Capacity AI is off", () => {
    expect(
      run(
        "CPL027",
        ctx({
          web: workload({
            spec: { type: "standard", defaultOptions: { capacityAI: false, autoscaling: { metric: "cpu" } } },
          }),
        }),
      ),
    ).toEqual([]);
  });
});

describe("CPL028 storage", () => {
  it("flags a capacity below the performance class floor", () => {
    const found = run(
      "CPL028",
      ctx({ data: volumeSet({ spec: { initialCapacity: 50, performanceClass: "high-throughput-ssd" } }) }),
    );
    expect(found.some((d) => d.message.includes("200 GB minimum"))).toBe(true);
  });

  it("flags an ext4 volume mounted by a non-stateful workload", () => {
    const found = run(
      "CPL028",
      ctx({
        data: volumeSet({ name: "data", gvc: "prod", spec: { initialCapacity: 20, fileSystemType: "ext4" } }),
        web: workload({
          name: "web",
          gvc: "prod",
          spec: {
            type: "serverless",
            containers: [{ name: "m", volumes: [{ uri: "cpln://volumeset/data", path: "/data" }] }],
          },
        }),
      }),
    );
    expect(found.some((d) => d.message.includes("stateful"))).toBe(true);
  });

  it("flags a cross-GVC mount", () => {
    const found = run(
      "CPL028",
      ctx({
        data: volumeSet({ name: "data", gvc: "staging", spec: { fileSystemType: "shared" } }),
        db: workload({
          name: "db",
          gvc: "prod",
          spec: {
            type: "stateful",
            containers: [{ name: "m", volumes: [{ uri: "cpln://volumeset/data", path: "/data" }] }],
          },
        }),
      }),
    );
    expect(found.some((d) => d.message.includes("own GVC"))).toBe(true);
  });

  it("flags nested mount paths", () => {
    const found = run(
      "CPL028",
      ctx({
        db: workload({
          spec: {
            type: "stateful",
            containers: [
              {
                name: "m",
                volumes: [
                  { uri: "cpln://volumeset/a", path: "/data" },
                  { uri: "cpln://volumeset/b", path: "/data/inner" },
                ],
              },
            ],
          },
        }),
      }),
    );
    expect(found.some((d) => d.message.includes("parent of another"))).toBe(true);
  });
});

describe("CPL029 link targets", () => {
  it("flags a link to an undeclared resource of a declared kind", () => {
    const found = run(
      "CPL029",
      ctx({
        prod: gvc({ name: "prod" }),
        web: workload({ name: "web", gvc: "prod", spec: { identityLink: "//gvc/prod/identity/missing" } }),
        api: { entityType: "Cpln::Core::Identity", props: { name: "api", gvc: "prod" } },
      }),
    );
    expect(found.some((d) => d.message.includes("no identity named \"missing\""))).toBe(true);
  });

  it("says nothing about a kind this stack does not declare", () => {
    // Referencing a secret another team manages is ordinary, not a defect.
    const found = run(
      "CPL029",
      ctx({
        prod: gvc({ name: "prod" }),
        web: workload({ name: "web", gvc: "prod", spec: { identityLink: "//gvc/prod/identity/elsewhere" } }),
      }),
    );
    expect(found).toEqual([]);
  });

  it("flags a workload whose identity is in another GVC", () => {
    const found = run(
      "CPL029",
      ctx({
        prod: gvc({ name: "prod" }),
        staging: gvc({ name: "staging" }),
        api: { entityType: "Cpln::Core::Identity", props: { name: "api", gvc: "staging" } },
        web: workload({ name: "web", gvc: "prod", spec: { identityLink: "//gvc/staging/identity/api" } }),
      }),
    );
    expect(found.some((d) => d.message.includes("cannot be shared across GVCs"))).toBe(true);
  });

  it("flags a resource placed in an undeclared GVC", () => {
    const found = run(
      "CPL029",
      ctx({
        prod: gvc({ name: "prod" }),
        web: workload({ name: "web", gvc: "typo" }),
      }),
    );
    expect(found.some((d) => d.message.includes('GVC "typo"'))).toBe(true);
  });
});

describe("CPL030 domain routing", () => {
  it("flags an apex domain in ns mode", () => {
    const found = run("CPL030", ctx({ d: domain({ name: "example.com", spec: { dnsMode: "ns", gvcLink: "//gvc/prod" } }) }));
    expect(found.some((d) => d.message.includes("apex"))).toBe(true);
  });

  it("flags ns mode with http01", () => {
    const found = run(
      "CPL030",
      ctx({ d: domain({ name: "api.example.com", spec: { dnsMode: "ns", certChallengeType: "http01", gvcLink: "//gvc/prod" } }) }),
    );
    expect(found.some((d) => d.message.includes("dns01"))).toBe(true);
  });

  it("flags two routing targets at once", () => {
    const found = run(
      "CPL030",
      ctx({ d: domain({ name: "api.example.com", spec: { gvcLink: "//gvc/prod", workloadLink: "//gvc/prod/workload/w" } }) }),
    );
    expect(found.some((d) => d.message.includes("mutually exclusive"))).toBe(true);
  });

  it("flags workloadLink to a non-stateful workload", () => {
    const found = run(
      "CPL030",
      ctx({
        w: workload({ name: "w", gvc: "prod", spec: { type: "serverless" } }),
        d: domain({ name: "api.example.com", spec: { workloadLink: "//gvc/prod/workload/w" } }),
      }),
    );
    expect(found.some((d) => d.message.includes("stateful workloads only"))).toBe(true);
  });

  it("flags routes spanning two GVCs", () => {
    const found = run(
      "CPL030",
      ctx({
        d: domain({
          name: "api.example.com",
          spec: {
            ports: [
              {
                number: 443,
                routes: [
                  { prefix: "/a", workloadLink: "//gvc/prod/workload/a" },
                  { prefix: "/b", workloadLink: "//gvc/staging/workload/b" },
                ],
              },
            ],
          },
        }),
      }),
    );
    expect(found.some((d) => d.message.includes("same GVC"))).toBe(true);
  });
});

describe("CPL040 / CPL041 images", () => {
  const image = (value: string) => ctx({ web: workload({ spec: { containers: [{ name: "m", image: value }] } }) });

  it("flags :latest", () => {
    expect(run("CPL040", image("nginx:latest"))).toHaveLength(1);
  });

  it("flags an untagged image", () => {
    expect(run("CPL040", image("nginx"))[0].message).toContain("untagged");
  });

  it("accepts a pinned tag and a digest", () => {
    expect(run("CPL040", image("nginx:1.27"))).toEqual([]);
    expect(run("CPL040", image("nginx@sha256:abc123"))).toEqual([]);
  });

  it("flags a docker.io/ prefix and suggests the bare form", () => {
    const found = run("CPL041", image("docker.io/library/nginx:1.27"));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('use "nginx:1.27"');
  });

  it("flags the registry hostname form", () => {
    expect(run("CPL041", image("acme.registry.cpln.io/app:1.0"))[0].message).toContain("//image/app:1.0");
  });
});

describe("CPL042 GVC placement", () => {
  it("flags a GVC with no placement", () => {
    const found = run("CPL042", ctx({ g: gvc({ name: "prod" }) }));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("scheduled nowhere");
  });

  it("accepts location links", () => {
    expect(
      run(
        "CPL042",
        ctx({ g: gvc({ name: "prod", spec: { staticPlacement: { locationLinks: ["/org/acme/location/aws-us-east-1"] } } }) }),
      ),
    ).toEqual([]);
  });

  it("flags a link that is not a location", () => {
    const found = run(
      "CPL042",
      ctx({ g: gvc({ name: "prod", spec: { staticPlacement: { locationLinks: ["aws-us-east-1"] } } }) }),
    );
    expect(found.some((d) => d.message.includes("does not look like a location"))).toBe(true);
  });
});

describe("CPL043 policy scope", () => {
  it("flags a non-targetable kind", () => {
    const found = run("CPL043", ctx({ p: policy({ name: "p", targetKind: "ipset", target: "all" }) }));
    expect(found.some((d) => d.message.includes("not a valid policy target"))).toBe(true);
  });

  it("flags two target scopes", () => {
    const found = run(
      "CPL043",
      ctx({ p: policy({ name: "p", targetKind: "secret", target: "all", targetLinks: ["//secret/a"] }) }),
    );
    expect(found.some((d) => d.message.includes("exactly one target scope"))).toBe(true);
  });

  it("flags a hand-set origin", () => {
    const found = run("CPL043", ctx({ p: policy({ name: "p", targetKind: "secret", target: "all", origin: "default" }) }));
    expect(found.some((d) => d.message.includes("origin"))).toBe(true);
  });

  it("flags unsorted permissions", () => {
    const found = run(
      "CPL043",
      ctx({
        p: policy({ name: "p", targetKind: "secret", target: "all", bindings: [{ permissions: ["reveal", "edit"] }] }),
      }),
    );
    expect(found.some((d) => d.message.includes("sorted"))).toBe(true);
  });

  it("flags duplicate permissions", () => {
    const found = run(
      "CPL043",
      ctx({
        p: policy({ name: "p", targetKind: "secret", target: "all", bindings: [{ permissions: ["edit", "edit"] }] }),
      }),
    );
    expect(found.some((d) => d.message.includes("duplicate"))).toBe(true);
  });
});

describe("quantity and link parsing", () => {
  it("parses CPU quantities", () => {
    expect(parseCpuMillicores("50m")).toBe(50);
    expect(parseCpuMillicores("1")).toBe(1000);
    expect(parseCpuMillicores("1.5")).toBe(1500);
    expect(parseCpuMillicores("bogus")).toBeUndefined();
  });

  it("parses memory quantities", () => {
    expect(parseMemoryMib("128Mi")).toBe(128);
    expect(parseMemoryMib("1Gi")).toBe(1024);
    expect(parseMemoryMib("bogus")).toBeUndefined();
  });

  it("does not mistake a registry port for a tag", () => {
    expect(imageTag("registry:5000/app")).toBeUndefined();
    expect(imageTag("registry:5000/app:1.0")).toBe("1.0");
  });

  it("parses both link forms", () => {
    expect(parseLink("//secret/db")).toEqual({ kind: "secret", name: "db" });
    expect(parseLink("//gvc/prod/identity/api")).toEqual({ gvc: "prod", kind: "identity", name: "api" });
    expect(parseLink("not-a-link")).toBeUndefined();
  });
});
