import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";

// Import all checks
import { wk8005 } from "./wk8005";
import { wk8006 } from "./wk8006";
import { wk8041 } from "./wk8041";
import { wk8042 } from "./wk8042";
import { wk8101 } from "./wk8101";
import { wk8102 } from "./wk8102";
import { wk8103 } from "./wk8103";
import { wk8104 } from "./wk8104";
import { wk8105 } from "./wk8105";
import { wk8201 } from "./wk8201";
import { wk8202 } from "./wk8202";
import { wk8203 } from "./wk8203";
import { wk8204 } from "./wk8204";
import { wk8205 } from "./wk8205";
import { wk8207 } from "./wk8207";
import { wk8208 } from "./wk8208";
import { wk8209 } from "./wk8209";
import { wk8301 } from "./wk8301";
import { wk8302 } from "./wk8302";
import { wk8303 } from "./wk8303";
import { wk8304 } from "./wk8304";
import { wk8305 } from "./wk8305";
import { wk8306 } from "./wk8306";
import { wk8401 } from "./wk8401";
import { wk8402 } from "./wk8402";
import { wk8403 } from "./wk8403";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["k8s", yaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["k8s", yaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

// ── WK8005: Secrets in env ──────────────────────────────────────────
// Note: Tests with nested container properties (env, resources, securityContext,
// ports, probes) use JSON format because the core parseYAML line-based parser
// cannot handle deeply nested properties inside YAML array items.

describe("WK8005: Hardcoded secrets in env", () => {
  test("flags hardcoded password in env", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", env: [{ name: "DB_PASSWORD", value: "secret123" }] },
            ],
          },
        },
      },
    }));
    const diags = wk8005.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8005");
  });

  test("passes when env uses secretKeyRef", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db-secret", key: "password" } } }] },
            ],
          },
        },
      },
    }));
    const diags = wk8005.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when env var name is not sensitive", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", env: [{ name: "LOG_LEVEL", value: "info" }] },
            ],
          },
        },
      },
    }));
    const diags = wk8005.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8006: Latest tag ──────────────────────────────────────────────

describe("WK8006: Latest/untagged images", () => {
  test("flags image with :latest tag", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
`);
    const diags = wk8006.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8006");
  });

  test("flags untagged image", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx
`);
    const diags = wk8006.check(ctx);
    expect(diags.length).toBe(1);
  });

  test("passes for explicitly tagged image", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25
`);
    const diags = wk8006.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8041: API keys ────────────────────────────────────────────────

describe("WK8041: API keys in env", () => {
  test("flags Stripe key pattern", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", env: [{ name: "STRIPE_KEY", value: "sk_live_abc123def456" }] },
            ],
          },
        },
      },
    }));
    const diags = wk8041.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8041");
  });

  test("passes for normal values", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", env: [{ name: "APP_MODE", value: "production" }] },
            ],
          },
        },
      },
    }));
    const diags = wk8041.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8042: Private keys ───────────────────────────────────────────

describe("WK8042: Private keys in manifests", () => {
  test("flags private key in ConfigMap", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "config" },
      data: {
        "cert.pem": "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
      },
    }));
    const diags = wk8042.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8042");
  });

  test("passes for normal ConfigMap data", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "config" },
      data: { "config.json": '{"key": "value"}' },
    }));
    const diags = wk8042.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8101: Selector mismatch ──────────────────────────────────────

describe("WK8101: Selector must match template labels", () => {
  test("flags when matchLabels != template labels", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: different-app
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8101.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8101");
  });

  test("passes when selector matches template labels", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8101.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8102: Missing labels ─────────────────────────────────────────

describe("WK8102: Missing metadata.labels", () => {
  test("flags resource without labels", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8102.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8102");
  });

  test("passes with labels present", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: my-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8102.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8103: Container name ─────────────────────────────────────────

describe("WK8103: Container missing name", () => {
  test("flags container without name", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - image: app:1.0
`);
    const diags = wk8103.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8103");
  });

  test("passes with container name", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8103.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8104: Named ports ────────────────────────────────────────────

describe("WK8104: Unnamed container ports", () => {
  test("flags unnamed ports", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", ports: [{ containerPort: 8080 }] },
            ],
          },
        },
      },
    }));
    const diags = wk8104.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8104");
  });

  test("passes with named ports", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", ports: [{ containerPort: 8080, name: "http" }] },
            ],
          },
        },
      },
    }));
    const diags = wk8104.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8105: imagePullPolicy ────────────────────────────────────────

describe("WK8105: Missing imagePullPolicy", () => {
  test("flags missing imagePullPolicy", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "app", image: "app:1.0" }],
          },
        },
      },
    }));
    const diags = wk8105.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8105");
  });

  test("passes with explicit imagePullPolicy", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "app", image: "app:1.0", imagePullPolicy: "IfNotPresent" }],
          },
        },
      },
    }));
    const diags = wk8105.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8201: Resource limits ────────────────────────────────────────

describe("WK8201: Resource limits required", () => {
  test("flags container without resource limits", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "app", image: "app:1.0" }],
          },
        },
      },
    }));
    const diags = wk8201.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8201");
  });

  test("passes with resource limits", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", resources: { limits: { cpu: "500m", memory: "256Mi" } } },
            ],
          },
        },
      },
    }));
    const diags = wk8201.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8202: Privileged ─────────────────────────────────────────────

describe("WK8202: Privileged containers", () => {
  test("flags privileged: true", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: { privileged: true } },
            ],
          },
        },
      },
    }));
    const diags = wk8202.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8202");
  });

  test("passes with privileged: false", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: { privileged: false } },
            ],
          },
        },
      },
    }));
    const diags = wk8202.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8203: readOnlyRootFilesystem ─────────────────────────────────

describe("WK8203: readOnlyRootFilesystem", () => {
  test("flags missing readOnlyRootFilesystem", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: {} },
            ],
          },
        },
      },
    }));
    const diags = wk8203.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8203");
  });

  test("passes with readOnlyRootFilesystem: true", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: { readOnlyRootFilesystem: true } },
            ],
          },
        },
      },
    }));
    const diags = wk8203.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8204: runAsNonRoot ───────────────────────────────────────────

describe("WK8204: runAsNonRoot", () => {
  test("flags missing runAsNonRoot", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: {} },
            ],
          },
        },
      },
    }));
    const diags = wk8204.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8204");
  });

  test("warns when runAsNonRoot: true but no runAsUser", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: { runAsNonRoot: true } },
            ],
          },
        },
      },
    }));
    const diags = wk8204.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8204");
    expect(diags[0].message).toContain("no explicit runAsUser");
  });

  test("warns when runAsNonRoot: true with runAsUser: 0 (contradictory)", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: { runAsNonRoot: true, runAsUser: 0 } },
            ],
          },
        },
      },
    }));
    const diags = wk8204.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8204");
    expect(diags[0].message).toContain("contradictory");
  });

  test("passes with runAsNonRoot: true and runAsUser: 65534", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: { runAsNonRoot: true, runAsUser: 65534 } },
            ],
          },
        },
      },
    }));
    const diags = wk8204.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("pod-level runAsUser satisfies container-level runAsNonRoot", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            securityContext: { runAsUser: 1000 },
            containers: [
              { name: "app", image: "app:1.0", securityContext: { runAsNonRoot: true } },
            ],
          },
        },
      },
    }));
    const diags = wk8204.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8205: Drop capabilities ──────────────────────────────────────

describe("WK8205: Drop all capabilities", () => {
  test("flags missing capability drop", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: {} },
            ],
          },
        },
      },
    }));
    const diags = wk8205.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8205");
  });

  test("passes with drop ALL", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", securityContext: { capabilities: { drop: ["ALL"] } } },
            ],
          },
        },
      },
    }));
    const diags = wk8205.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8207: hostNetwork ────────────────────────────────────────────

describe("WK8207: hostNetwork", () => {
  test("flags hostNetwork: true", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      hostNetwork: true
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8207.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8207");
  });

  test("passes without hostNetwork", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8207.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8208: hostPID ────────────────────────────────────────────────

describe("WK8208: hostPID", () => {
  test("flags hostPID: true", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      hostPID: true
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8208.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8208");
  });

  test("passes without hostPID", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8208.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8209: hostIPC ────────────────────────────────────────────────

describe("WK8209: hostIPC", () => {
  test("flags hostIPC: true", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      hostIPC: true
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8209.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8209");
  });

  test("passes without hostIPC", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8209.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8301: Probes required ────────────────────────────────────────

describe("WK8301: Probes required", () => {
  test("flags container without probes", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "app", image: "app:1.0" }],
          },
        },
      },
    }));
    const diags = wk8301.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8301");
  });

  test("passes with both probes", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1.0",
                livenessProbe: { httpGet: { path: "/healthz", port: 8080 } },
                readinessProbe: { httpGet: { path: "/readyz", port: 8080 } },
              },
            ],
          },
        },
      },
    }));
    const diags = wk8301.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("skips Job (probes not needed)", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "job" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "worker", image: "worker:1.0" }],
          },
        },
      },
    }));
    const diags = wk8301.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("skips CronJob", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: "cron" },
      spec: {
        schedule: "0 * * * *",
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: [{ name: "cron", image: "cron:1.0" }],
              },
            },
          },
        },
      },
    }));
    const diags = wk8301.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8302: Single replica ─────────────────────────────────────────

describe("WK8302: Single replica deployment", () => {
  test("flags replicas: 1", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8302.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8302");
  });

  test("passes with replicas: 3", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8302.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8303: PDB missing ───────────────────────────────────────────

describe("WK8303: HA Deployment without PDB", () => {
  test("flags HA Deployment without PDB", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: app:1.0
`);
    const diags = wk8303.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8303");
  });

  test("passes with PDB present", () => {
    const ctx = makeCtx(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: app:1.0
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: app-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: my-app
`);
    const diags = wk8303.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8304: SSL redirect without certificate ────────────────────────

describe("WK8304: SSL redirect without certificate", () => {
  test("flags ssl-redirect without certificate-arn", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: "app-ingress",
        annotations: {
          "alb.ingress.kubernetes.io/ssl-redirect": "443",
          "alb.ingress.kubernetes.io/scheme": "internet-facing",
        },
      },
      spec: { rules: [] },
    }));
    const diags = wk8304.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8304");
    expect(diags[0].severity).toBe("warning");
  });

  test("flags ssl-redirect with valid cert but no HTTPS in listen-ports", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: "app-ingress",
        annotations: {
          "alb.ingress.kubernetes.io/ssl-redirect": "443",
          "alb.ingress.kubernetes.io/certificate-arn": "arn:aws:acm:us-east-1:123:certificate/abc",
          "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP":80}]',
        },
      },
      spec: { rules: [] },
    }));
    const diags = wk8304.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8304");
  });

  test("passes with valid cert and HTTPS listen-ports", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: "app-ingress",
        annotations: {
          "alb.ingress.kubernetes.io/ssl-redirect": "443",
          "alb.ingress.kubernetes.io/certificate-arn": "arn:aws:acm:us-east-1:123:certificate/abc",
          "alb.ingress.kubernetes.io/listen-ports": '[{"HTTPS":443}]',
        },
      },
      spec: { rules: [] },
    }));
    const diags = wk8304.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes with no ssl-redirect annotation", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: "app-ingress",
        annotations: {
          "alb.ingress.kubernetes.io/scheme": "internet-facing",
        },
      },
      spec: { rules: [] },
    }));
    const diags = wk8304.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8305: Ingress port not matching Service ───────────────────────

describe("WK8305: Ingress port not matching Service", () => {
  test("flags Ingress backend port not on Service", () => {
    const svc = JSON.stringify({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "api", namespace: "default" },
      spec: { ports: [{ port: 80, targetPort: 8080 }] },
    });
    const ingress = JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "api-ingress", namespace: "default" },
      spec: {
        rules: [{
          host: "api.example.com",
          http: {
            paths: [{
              path: "/",
              backend: { service: { name: "api", port: { number: 8080 } } },
            }],
          },
        }],
      },
    });
    const ctx = makeCtx(`${svc}\n---\n${ingress}`);
    const diags = wk8305.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8305");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes when port matches Service", () => {
    const svc = JSON.stringify({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "api", namespace: "default" },
      spec: { ports: [{ port: 80, targetPort: 8080 }] },
    });
    const ingress = JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "api-ingress", namespace: "default" },
      spec: {
        rules: [{
          host: "api.example.com",
          http: {
            paths: [{
              path: "/",
              backend: { service: { name: "api", port: { number: 80 } } },
            }],
          },
        }],
      },
    });
    const ctx = makeCtx(`${svc}\n---\n${ingress}`);
    const diags = wk8305.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("skips when Service not in manifest set", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "api-ingress", namespace: "default" },
      spec: {
        rules: [{
          host: "api.example.com",
          http: {
            paths: [{
              path: "/",
              backend: { service: { name: "external-svc", port: { number: 443 } } },
            }],
          },
        }],
      },
    }));
    const diags = wk8305.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes with multiple Services, correct match", () => {
    const svc1 = JSON.stringify({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "api", namespace: "prod" },
      spec: { ports: [{ port: 80 }, { port: 443 }] },
    });
    const svc2 = JSON.stringify({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web", namespace: "prod" },
      spec: { ports: [{ port: 3000 }] },
    });
    const ingress = JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "main-ingress", namespace: "prod" },
      spec: {
        rules: [{
          host: "app.example.com",
          http: {
            paths: [
              { path: "/api", backend: { service: { name: "api", port: { number: 443 } } } },
              { path: "/", backend: { service: { name: "web", port: { number: 3000 } } } },
            ],
          },
        }],
      },
    });
    const ctx = makeCtx(`${svc1}\n---\n${svc2}\n---\n${ingress}`);
    const diags = wk8305.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8306: Container command starts with flag ───────────────────

describe("WK8306: Container command starts with flag", () => {
  test("flags command[0] starting with --", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "adot" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "collector", image: "otel:1.0", command: ["--config=/etc/adot/config.yaml"] },
            ],
          },
        },
      },
    }));
    const diags = wk8306.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8306");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("--config");
  });

  test("flags command[0] starting with -", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", command: ["-c", "echo hello"] },
            ],
          },
        },
      },
    }));
    const diags = wk8306.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe("error");
  });

  test("passes when command[0] is a binary path", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", command: ["/usr/bin/app", "--flag"] },
            ],
          },
        },
      },
    }));
    const diags = wk8306.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when flags are in args (correct usage)", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", args: ["--config=foo"] },
            ],
          },
        },
      },
    }));
    const diags = wk8306.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when no command field", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0" },
            ],
          },
        },
      },
    }));
    const diags = wk8306.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WK8401: shmSize exceeds memory limit ────────────────────────────────────

function makeRayCluster(overrides: {
  shmSizeLimit?: string;
  memoryLimit?: string;
  workerShmSizeLimit?: string;
  workerMemoryLimit?: string;
  rayVersion?: string;
  headImage?: string;
}) {
  const headImage = overrides.headImage ?? "rayproject/ray:2.40.0-py310-cpu";
  return JSON.stringify({
    apiVersion: "ray.io/v1alpha1",
    kind: "RayCluster",
    metadata: { name: "ray" },
    spec: {
      ...(overrides.rayVersion !== undefined && { rayVersion: overrides.rayVersion }),
      headGroupSpec: {
        template: {
          spec: {
            volumes: [{ name: "dshm", emptyDir: { medium: "Memory", ...(overrides.shmSizeLimit !== undefined && { sizeLimit: overrides.shmSizeLimit }) } }],
            containers: [{ name: "ray-head", image: headImage, resources: { limits: { memory: overrides.memoryLimit ?? "8Gi" } } }],
          },
        },
      },
      workerGroupSpecs: [
        {
          groupName: "cpu",
          template: {
            spec: {
              volumes: [{ name: "dshm", emptyDir: { medium: "Memory", ...(overrides.workerShmSizeLimit !== undefined && { sizeLimit: overrides.workerShmSizeLimit }) } }],
              containers: [{ name: "ray-worker", image: headImage, resources: { limits: { memory: overrides.workerMemoryLimit ?? "4Gi" } } }],
            },
          },
        },
      ],
    },
  });
}

describe("WK8401: shmSize exceeds memory limit", () => {
  test("passes when shmSize equals memory limit", () => {
    const ctx = makeCtx(makeRayCluster({ shmSizeLimit: "8Gi", memoryLimit: "8Gi" }));
    const diags = wk8401.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8401").length).toBe(0);
  });

  test("passes when shmSize is less than memory limit", () => {
    const ctx = makeCtx(makeRayCluster({ shmSizeLimit: "2Gi", memoryLimit: "8Gi" }));
    const diags = wk8401.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8401").length).toBe(0);
  });

  test("errors when head shmSize exceeds memory limit", () => {
    const ctx = makeCtx(makeRayCluster({ shmSizeLimit: "16Gi", memoryLimit: "8Gi" }));
    const diags = wk8401.check(ctx);
    const errors = diags.filter((d) => d.checkId === "WK8401" && d.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain("head");
    expect(errors[0].message).toContain("16Gi");
  });

  test("errors when worker shmSize exceeds memory limit", () => {
    const ctx = makeCtx(makeRayCluster({ workerShmSizeLimit: "8Gi", workerMemoryLimit: "4Gi" }));
    const diags = wk8401.check(ctx);
    const errors = diags.filter((d) => d.checkId === "WK8401" && d.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain("worker");
  });

  test("skips check when no sizeLimit set on emptyDir", () => {
    const ctx = makeCtx(makeRayCluster({ shmSizeLimit: undefined }));
    const diags = wk8401.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8401").length).toBe(0);
  });

  test("ignores non-RayCluster manifests", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: { template: { spec: { volumes: [{ name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "16Gi" } }], containers: [{ name: "app", image: "app:1.0", resources: { limits: { memory: "4Gi" } } }] } } },
    }));
    const diags = wk8401.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8401").length).toBe(0);
  });
});

// ── WK8402: RayCluster missing spec.rayVersion ───────────────────────────────

describe("WK8402: RayCluster missing spec.rayVersion", () => {
  test("passes when rayVersion is set", () => {
    const ctx = makeCtx(makeRayCluster({ rayVersion: "2.40.0" }));
    const diags = wk8402.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8402").length).toBe(0);
  });

  test("warns when rayVersion is absent", () => {
    const ctx = makeCtx(makeRayCluster({}));
    const diags = wk8402.check(ctx);
    const warns = diags.filter((d) => d.checkId === "WK8402");
    expect(warns.length).toBe(1);
    expect(warns[0].severity).toBe("warning");
    expect(warns[0].message).toContain("latest");
  });

  test("ignores non-RayCluster manifests", () => {
    const ctx = makeCtx(JSON.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "app" }, spec: {} }));
    const diags = wk8402.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8402").length).toBe(0);
  });
});

// ── WK8403: spec.rayVersion / image tag mismatch ─────────────────────────────

describe("WK8403: spec.rayVersion does not match image tag", () => {
  test("passes when versions match", () => {
    const ctx = makeCtx(makeRayCluster({ rayVersion: "2.40.0", headImage: "rayproject/ray:2.40.0-py310-cpu" }));
    const diags = wk8403.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8403").length).toBe(0);
  });

  test("warns when rayVersion does not match image tag", () => {
    const ctx = makeCtx(makeRayCluster({ rayVersion: "2.39.0", headImage: "rayproject/ray:2.40.0-py310-cpu" }));
    const diags = wk8403.check(ctx);
    const warns = diags.filter((d) => d.checkId === "WK8403");
    expect(warns.length).toBe(1);
    expect(warns[0].severity).toBe("warning");
    expect(warns[0].message).toContain("2.39.0");
    expect(warns[0].message).toContain("2.40.0");
  });

  test("skips when rayVersion is absent (WK8402 covers that)", () => {
    const ctx = makeCtx(makeRayCluster({ headImage: "rayproject/ray:2.40.0" }));
    const diags = wk8403.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8403").length).toBe(0);
  });

  test("skips when image tag has no parseable version", () => {
    const ctx = makeCtx(makeRayCluster({ rayVersion: "2.40.0", headImage: "rayproject/ray:latest" }));
    const diags = wk8403.check(ctx);
    expect(diags.filter((d) => d.checkId === "WK8403").length).toBe(0);
  });
});
