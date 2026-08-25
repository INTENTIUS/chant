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
import { wk8404 } from "./wk8404";
import { wk8405 } from "./wk8405";
import { wk8406 } from "./wk8406";
import { wk8407 } from "./wk8407";
import { argo002 } from "./argo002";
import { argo003 } from "./argo003";
import { argo005 } from "./argo005";
import { flux002 } from "./flux002";
import { flux003 } from "./flux003";
import { wk8501 } from "./wk8501";
import { wk8502 } from "./wk8502";
import { wk8503 } from "./wk8503";
import { wk8504 } from "./wk8504";
import { declareSecret, type SecretDeclarationInput } from "@intentius/chant/secret-provenance";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCrdSchemaRegistry, setCrdSchemaRegistry, validateSpec } from "./crd-schema-helpers";

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

/** Join several manifests (objects) into a multi-document YAML string. */
function manifestsCtx(...objs: unknown[]): PostSynthContext {
  return makeCtx(objs.map((o) => JSON.stringify(o)).join("\n---\n"));
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

  // #1482 — the manifest arrives as real YAML, and the initContainer's args is
  // a block scalar. The parser bug turned `- |` into the string "|" and hoisted
  // every key after it (securityContext, the containers list itself) to the
  // document root, so this check warned on a compliant initContainer and never
  // saw the app container at all.
  test("initContainer with a block-scalar arg keeps its securityContext, and the app container is still checked (#1482)", () => {
    const yaml = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: app",
      "spec:",
      "  template:",
      "    spec:",
      "      initContainers:",
      "        - name: wait",
      "          image: pg:16",
      "          args:",
      "            - |",
      "              set -eu",
      "              echo ready",
      "          securityContext:",
      "            runAsNonRoot: true",
      "            runAsUser: 1001",
      "      containers:",
      "        - name: app",
      "          image: app:1.0",
      "          securityContext: {}",
      "",
    ].join("\n");
    const ctx = makeCtx(yaml);
    const diags = wk8204.check(ctx);
    // The compliant initContainer produces nothing; the bare app container is
    // the one — and the only one — that warns.
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain('"app"');
    expect(diags[0].message).not.toContain("wait");
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
  test("flags port-serving container without probes", () => {
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
    const diags = wk8301.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("WK8301");
  });

  test("skips port-less worker Deployment (no inbound traffic to probe)", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "worker" },
      spec: {
        template: {
          spec: {
            // A queue/Temporal worker — long-running, no port, no probes by design.
            containers: [{ name: "worker", image: "worker:1.0" }],
          },
        },
      },
    }));
    const diags = wk8301.check(ctx);
    expect(diags.length).toBe(0);
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
                ports: [{ containerPort: 8080 }],
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

// ── WK8404: GPU request without a matching toleration ─────────────────────────

function servingRuntime(opts: {
  resources?: Record<string, unknown>;
  tolerations?: unknown[];
  kind?: string;
}) {
  return {
    apiVersion: "serving.kserve.io/v1alpha1",
    kind: opts.kind ?? "ServingRuntime",
    metadata: { name: "vllm-runtime", namespace: "models" },
    spec: {
      containers: [
        {
          name: "kserve-container",
          image: "vllm/vllm-openai:v0.7.0",
          ...(opts.resources && { resources: opts.resources }),
        },
      ],
      ...(opts.tolerations && { tolerations: opts.tolerations }),
    },
  };
}

describe("WK8404: GPU request without a matching toleration", () => {
  test("flags a GPU request with no toleration", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({
      resources: { requests: { "nvidia.com/gpu": "1" }, limits: { "nvidia.com/gpu": "1" } },
    })));
    const diags = wk8404.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8404");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("nvidia.com/gpu");
  });

  test("passes with an explicit nvidia.com/gpu toleration", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({
      resources: { requests: { "nvidia.com/gpu": "1" }, limits: { "nvidia.com/gpu": "1" } },
      tolerations: [{ key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" }],
    })));
    expect(wk8404.check(ctx).length).toBe(0);
  });

  test("passes with a wildcard Exists toleration (no key)", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({
      resources: { requests: { "nvidia.com/gpu": "1" } },
      tolerations: [{ operator: "Exists" }],
    })));
    expect(wk8404.check(ctx).length).toBe(0);
  });

  test("skips containers that don't request a GPU", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({
      resources: { requests: { cpu: "2" }, limits: { cpu: "2" } },
    })));
    expect(wk8404.check(ctx).length).toBe(0);
  });

  test("also flags a plain Deployment requesting a GPU with no toleration", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "gpu-app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", resources: { requests: { "nvidia.com/gpu": "2" }, limits: { "nvidia.com/gpu": "2" } } },
            ],
          },
        },
      },
    }));
    const diags = wk8404.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].entity).toBe("gpu-app");
  });
});

// ── WK8405: Serving workload without a PodDisruptionBudget ─────────────────────

function inferenceService(opts: { name?: string; labels?: Record<string, string> }) {
  return {
    apiVersion: "serving.kserve.io/v1beta1",
    kind: "InferenceService",
    metadata: {
      name: opts.name ?? "llama-3-8b",
      namespace: "serving",
      labels: { "app.kubernetes.io/component": "inference-service", ...opts.labels },
    },
    spec: {
      predictor: {
        model: { runtime: "vllm-runtime", storageUri: "gs://my-models/llama-3-8b/v1" },
      },
    },
  };
}

function pdb(matchLabels: Record<string, string>) {
  return {
    apiVersion: "policy/v1",
    kind: "PodDisruptionBudget",
    metadata: { name: "pdb" },
    spec: { minAvailable: 1, selector: { matchLabels } },
  };
}

describe("WK8405: Serving workload without a PDB", () => {
  test("flags an InferenceService with no covering PDB", () => {
    const ctx = makeCtx(JSON.stringify(inferenceService({})));
    const diags = wk8405.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8405");
    expect(diags[0].severity).toBe("info");
  });

  test("passes when a PDB selector covers the InferenceService's labels", () => {
    const ctx = manifestsCtx(
      inferenceService({}),
      pdb({ "app.kubernetes.io/component": "inference-service" }),
    );
    expect(wk8405.check(ctx).length).toBe(0);
  });

  test("flags a Deployment labeled as a serving component with no PDB", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "serving-dep", labels: { "app.kubernetes.io/component": "vllm-serving-runtime" } },
      spec: { replicas: 1, template: { spec: { containers: [{ name: "app", image: "app:1.0" }] } } },
    }));
    const diags = wk8405.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].entity).toBe("serving-dep");
  });

  test("ignores a plain Deployment with no serving component label", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "other-dep", labels: { "app.kubernetes.io/component": "web" } },
      spec: { replicas: 1, template: { spec: { containers: [{ name: "app", image: "app:1.0" }] } } },
    }));
    expect(wk8405.check(ctx).length).toBe(0);
  });
});

// ── WK8406: No resource limits on a GPU pod ─────────────────────────────────

describe("WK8406: GPU container missing resource limits", () => {
  test("flags a GPU-requesting container with no limits", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({
      resources: { requests: { "nvidia.com/gpu": "1" } },
    })));
    const diags = wk8406.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8406");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("cpu, memory");
  });

  test("flags a GPU-requesting container missing only memory limit", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({
      resources: { requests: { "nvidia.com/gpu": "1" }, limits: { cpu: "4", "nvidia.com/gpu": "1" } },
    })));
    const diags = wk8406.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("memory");
    expect(diags[0].message).not.toContain("cpu,");
  });

  test("passes with full cpu/memory limits on the GPU container", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({
      resources: { requests: { "nvidia.com/gpu": "1" }, limits: { cpu: "4", memory: "16Gi", "nvidia.com/gpu": "1" } },
    })));
    expect(wk8406.check(ctx).length).toBe(0);
  });

  test("ignores containers with no GPU request even without limits", () => {
    const ctx = makeCtx(JSON.stringify(servingRuntime({})));
    expect(wk8406.check(ctx).length).toBe(0);
  });
});

// ── WK8407: Unpinned model version ──────────────────────────────────────────

describe("WK8407: Unpinned model version", () => {
  test("flags a storageUri with no version segment", () => {
    const manifest = inferenceService({});
    manifest.spec.predictor.model.storageUri = "gs://my-models-bucket";
    const diags = wk8407.check(makeCtx(JSON.stringify(manifest)));
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8407");
    expect(diags[0].severity).toBe("warning");
  });

  test("flags a floating tag (latest) as unpinned", () => {
    const manifest = inferenceService({});
    manifest.spec.predictor.model.storageUri = "gs://my-models-bucket/llama-3-8b/latest";
    const diags = wk8407.check(makeCtx(JSON.stringify(manifest)));
    expect(diags.length).toBe(1);
  });

  test("passes a pinned storageUri (scheme://id/version)", () => {
    const manifest = inferenceService({});
    manifest.spec.predictor.model.storageUri = "gs://my-models/llama-3-8b/2024-07-01";
    const diags = wk8407.check(makeCtx(JSON.stringify(manifest)));
    expect(diags.length).toBe(0);
  });

  test("passes a pinned storageUri with a semver version", () => {
    const manifest = inferenceService({});
    manifest.spec.predictor.model.storageUri = "hf://meta-llama/Llama-3-8B/v1.0.0";
    const diags = wk8407.check(makeCtx(JSON.stringify(manifest)));
    expect(diags.length).toBe(0);
  });

  test("ignores non-InferenceService manifests", () => {
    const ctx = makeCtx(JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: { template: { spec: { containers: [{ name: "app", image: "app:1.0" }] } } },
    }));
    expect(wk8407.check(ctx).length).toBe(0);
  });
});

// ── ARGO002: Application.spec.project references a declared AppProject ─────────

function argoApp(name: string, spec: Record<string, unknown>) {
  return { apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: { name }, spec };
}
function appProject(name: string) {
  return { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject", metadata: { name }, spec: {} };
}
const inClusterDest = { server: "https://kubernetes.default.svc", namespace: "demo" };

describe("ARGO002: Application project references a declared AppProject", () => {
  test("metadata", () => {
    expect(argo002.id).toBe("ARGO002");
  });

  test("flags an Application referencing an undeclared project", () => {
    const ctx = manifestsCtx(argoApp("api", { project: "team-a", destination: inClusterDest }));
    const diags = argo002.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("ARGO002");
    expect(diags[0].message).toContain("team-a");
  });

  test("passes when the AppProject is declared in the same build", () => {
    const ctx = manifestsCtx(
      appProject("team-a"),
      argoApp("api", { project: "team-a", destination: inClusterDest }),
    );
    expect(argo002.check(ctx).length).toBe(0);
  });

  test("does NOT flag the built-in default project", () => {
    const ctx = manifestsCtx(argoApp("api", { project: "default", destination: inClusterDest }));
    expect(argo002.check(ctx).length).toBe(0);
  });
});

// ── ARGO003: Application destination references a registered cluster ──────────

function clusterSecret(name: string, server: string) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, labels: { "argocd.argoproj.io/secret-type": "cluster" } },
    stringData: { name, server },
  };
}

describe("ARGO003: Application destination references a registered cluster", () => {
  test("metadata", () => {
    expect(argo003.id).toBe("ARGO003");
  });

  test("does NOT flag the in-cluster destination", () => {
    const ctx = manifestsCtx(argoApp("api", { project: "default", destination: inClusterDest }));
    expect(argo003.check(ctx).length).toBe(0);
  });

  test("flags an unregistered cluster server", () => {
    const ctx = manifestsCtx(
      argoApp("api", { project: "default", destination: { server: "https://prod.example.com", namespace: "demo" } }),
    );
    const diags = argo003.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("ARGO003");
    expect(diags[0].message).toContain("prod.example.com");
  });

  test("passes when the cluster is registered via a cluster Secret", () => {
    const ctx = manifestsCtx(
      clusterSecret("prod", "https://prod.example.com"),
      argoApp("api", { project: "default", destination: { server: "https://prod.example.com", namespace: "demo" } }),
    );
    expect(argo003.check(ctx).length).toBe(0);
  });

  test("flags a destination with neither server nor name", () => {
    const ctx = manifestsCtx(argoApp("api", { project: "default", destination: { namespace: "demo" } }));
    expect(argo003.check(ctx).length).toBe(1);
  });
});

// ── ARGO005: Application source.path resolves to an existing directory ────────

describe("ARGO005: Application source path exists", () => {
  test("metadata", () => {
    expect(argo005.id).toBe("ARGO005");
  });

  test("does NOT flag a path that exists under the build root", () => {
    // `lexicons` is a directory at the repo root (the vitest cwd).
    const ctx = manifestsCtx(
      argoApp("api", { project: "default", destination: inClusterDest, source: { repoURL: "x", path: "lexicons" } }),
    );
    expect(argo005.check(ctx).length).toBe(0);
  });

  test("warns on a path that does not resolve to a directory", () => {
    const ctx = manifestsCtx(
      argoApp("api", { project: "default", destination: inClusterDest, source: { repoURL: "x", path: "no-such-argo-dir-xyz" } }),
    );
    const diags = argo005.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("ARGO005");
    expect(diags[0].severity).toBe("warning");
  });

  test("skips Helm chart sources", () => {
    const ctx = manifestsCtx(
      argoApp("api", { project: "default", destination: inClusterDest, source: { repoURL: "x", chart: "redis" } }),
    );
    expect(argo005.check(ctx).length).toBe(0);
  });
});

// ── FLUX002: Kustomization sourceRef references a declared source ─────────────

function fluxKustomization(name: string, spec: Record<string, unknown>) {
  return {
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: { name, namespace: "flux-system" },
    spec: { interval: "10m", path: "./k8s", prune: true, wait: true, ...spec },
  };
}
function fluxGitRepository(name: string) {
  return {
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "GitRepository",
    metadata: { name, namespace: "flux-system" },
    spec: { interval: "5m", url: `https://example.com/${name}`, ref: { branch: "main" } },
  };
}
const gitSourceRef = (name: string) => ({ sourceRef: { kind: "GitRepository", name } });

describe("FLUX002: Kustomization sourceRef references a declared source", () => {
  test("metadata", () => {
    expect(flux002.id).toBe("FLUX002");
  });

  test("flags a Kustomization referencing an undeclared GitRepository", () => {
    const ctx = manifestsCtx(fluxKustomization("hello", gitSourceRef("home-chant")));
    const diags = flux002.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("FLUX002");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("home-chant");
  });

  test("passes when the GitRepository is declared in the same build", () => {
    const ctx = manifestsCtx(
      fluxGitRepository("home-chant"),
      fluxKustomization("hello", gitSourceRef("home-chant")),
    );
    expect(flux002.check(ctx).length).toBe(0);
  });

  test("does NOT flag the bootstrap-created flux-system source", () => {
    const ctx = manifestsCtx(fluxKustomization("mealie", gitSourceRef("flux-system")));
    expect(flux002.check(ctx).length).toBe(0);
  });

  test("matches on source kind — a GitRepository does not satisfy an OCIRepository ref", () => {
    const ctx = manifestsCtx(
      fluxGitRepository("fountain"),
      fluxKustomization("fountain", { sourceRef: { kind: "OCIRepository", name: "fountain" } }),
    );
    const diags = flux002.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("OCIRepository");
  });

  test("flags a Kustomization with no sourceRef at all", () => {
    const ctx = manifestsCtx(fluxKustomization("hello", {}));
    const diags = flux002.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("no spec.sourceRef.name");
  });

  test("skips kustomize.config.k8s.io Kustomizations (not Flux CRs)", () => {
    const ctx = manifestsCtx({
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
      metadata: { name: "overlay" },
      spec: {},
    });
    expect(flux002.check(ctx).length).toBe(0);
  });
});

// ── FLUX003: Kustomization dependsOn names declared Kustomizations ────────────

describe("FLUX003: Kustomization dependsOn names declared Kustomizations", () => {
  test("metadata", () => {
    expect(flux003.id).toBe("FLUX003");
  });

  test("flags a dependsOn entry nothing in the build declares", () => {
    const ctx = manifestsCtx(
      fluxKustomization("hello", { ...gitSourceRef("flux-system"), dependsOn: [{ name: "cert-manger" }] }),
    );
    const diags = flux003.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("FLUX003");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("cert-manger");
  });

  test("passes when every dependency is declared", () => {
    const ctx = manifestsCtx(
      fluxKustomization("cert-manager", gitSourceRef("flux-system")),
      fluxKustomization("traefik", gitSourceRef("flux-system")),
      fluxKustomization("hello", {
        ...gitSourceRef("flux-system"),
        dependsOn: [{ name: "cert-manager" }, { name: "traefik" }],
      }),
    );
    expect(flux003.check(ctx).length).toBe(0);
  });

  test("flags a self-referencing dependsOn entry", () => {
    const ctx = manifestsCtx(
      fluxKustomization("hello", { ...gitSourceRef("flux-system"), dependsOn: [{ name: "hello" }] }),
    );
    const diags = flux003.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("itself");
  });

  test("reports every broken edge, not just the first", () => {
    const ctx = manifestsCtx(
      fluxKustomization("hello", {
        ...gitSourceRef("flux-system"),
        dependsOn: [{ name: "nope-a" }, { name: "nope-b" }],
      }),
    );
    expect(flux003.check(ctx).length).toBe(2);
  });

  test("skips a Kustomization without dependsOn", () => {
    const ctx = manifestsCtx(fluxKustomization("hello", gitSourceRef("flux-system")));
    expect(flux003.check(ctx).length).toBe(0);
  });
});

// ── WK8501 / WK8502: custom-resource spec against the CRD schema (chant #1372) ──

describe("WK8501/WK8502: custom resource spec validated against the shipped CRD schema", () => {
  const hasLexicon = getCrdSchemaRegistry().size > 0;

  function microVm(spec: Record<string, unknown>) {
    return {
      apiVersion: "lambda.aws.amazon.com/v1alpha1",
      kind: "MicroVM",
      metadata: { name: "agent-1", namespace: "vms" },
      spec,
    };
  }

  // chant #13 — CAPI's own Cluster (K8s::CAPI::Cluster) and ACK's S3 Bucket
  // (K8s::S3::Bucket), the CAPI/CAPA and ACK kinds this suite's WK8501/WK8502
  // coverage exercises. Same shape as `microVm` above: a bare manifest, spec
  // supplied per test.
  function capiCluster(spec: Record<string, unknown>) {
    return {
      apiVersion: "cluster.x-k8s.io/v1beta2",
      kind: "Cluster",
      metadata: { name: "prod-cluster", namespace: "capi-system" },
      spec,
    };
  }

  function ackBucket(spec: Record<string, unknown>) {
    return {
      apiVersion: "s3.services.k8s.aws/v1alpha1",
      kind: "Bucket",
      metadata: { name: "build-artifacts", namespace: "aws-system" },
      spec,
    };
  }

  test("metadata", () => {
    expect(wk8501.id).toBe("WK8501");
    expect(wk8502.id).toBe("WK8502");
  });

  test.skipIf(!hasLexicon)("the lexicon ships a spec schema for every CRD-derived kind", () => {
    const registry = getCrdSchemaRegistry();
    for (const key of ["lambda.aws.amazon.com/v1alpha1/MicroVM", "cert-manager.io/v1/Certificate", "ray.io/v1/RayCluster"]) {
      expect(registry.get(key)?.type, key).toBe("object");
    }
    // Built-in kinds are typed by the .d.ts and carry no schema.
    expect(registry.has("apps/v1/Deployment")).toBe(false);
  });

  test.skipIf(!hasLexicon)("WK8501 flags a misspelled MicroVM field and suggests the real one", () => {
    // The kubemicrovm-ops case from #1372: `classname` type-checks, applies
    // cleanly, and the controller runs the VM with the default class.
    const ctx = manifestsCtx(microVm({ classname: "large", imageRef: "img" }));
    const diags = wk8501.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("agent-1");
    expect(diags[0].message).toContain('unknown field "spec.classname"');
    expect(diags[0].message).toContain('did you mean "className"');
    // WK8502 has nothing to say about a field the schema does not know.
    expect(wk8502.check(ctx).length).toBe(0);
  });

  test.skipIf(!hasLexicon)("WK8502 flags a wrong-typed scalar and a value outside its enum", () => {
    const ctx = manifestsCtx(microVm({
      className: "large",
      maxIdleDurationSeconds: "300",
      desiredState: "Runing",
      autoResumeEnabled: "yes",
    }));
    const diags = wk8502.check(ctx);
    const messages = diags.map((d) => d.message);
    expect(messages).toEqual([
      expect.stringContaining('"spec.maxIdleDurationSeconds" expects an integer, got string "300"'),
      expect.stringContaining('"spec.desiredState" must be one of "Running", "Suspended", "Terminated", got string "Runing"'),
      expect.stringContaining('"spec.autoResumeEnabled" expects a boolean, got string "yes"'),
    ]);
    expect(diags.every((d) => d.checkId === "WK8502" && d.severity === "error")).toBe(true);
    expect(wk8501.check(ctx).length).toBe(0);
  });

  test.skipIf(!hasLexicon)("a well-formed custom resource passes both checks", () => {
    const ctx = manifestsCtx(
      microVm({ className: "large", desiredState: "Running", maxIdleDurationSeconds: 300, tags: { team: "ml", any: 1 } }),
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: "web-tls" },
        spec: {
          secretName: "web-tls",
          dnsNames: ["example.com"],
          issuerRef: { name: "letsencrypt", kind: "ClusterIssuer" },
          privateKey: { algorithm: "ECDSA", size: 256 },
        },
      },
    );
    expect(wk8501.check(ctx)).toEqual([]);
    expect(wk8502.check(ctx)).toEqual([]);
  });

  test.skipIf(!hasLexicon)("walks nested objects and array elements", () => {
    const ctx = manifestsCtx({
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "web-tls" },
      spec: {
        secretName: "web-tls",
        issuerRef: { nmae: "letsencrypt" },
        additionalOutputFormats: [{ type: "DER" }, { type: "PEM" }],
        privateKey: { algorithm: "DSA" },
      },
    });
    expect(wk8501.check(ctx).map((d) => d.message)).toEqual([
      expect.stringContaining('unknown field "spec.issuerRef.nmae" (did you mean "name"?)'),
    ]);
    expect(wk8502.check(ctx).map((d) => d.message)).toEqual([
      expect.stringContaining('"spec.additionalOutputFormats[1].type" must be one of "DER", "CombinedPEM"'),
      expect.stringContaining('"spec.privateKey.algorithm" must be one of "RSA", "ECDSA", "Ed25519"'),
    ]);
  });

  // chant #13 — coverage proving the epic's actual point: the CAPI/CAPA and
  // ACK sources added in #10/#11/#12 carry the same WK8501/WK8502 schema
  // guarantee as every other CRD source, not just types with no lint behind
  // them.

  test.skipIf(!hasLexicon)("WK8501 flags a misspelled CAPI Cluster field and suggests the real one", () => {
    const ctx = manifestsCtx(capiCluster({ paused: true, clusterNetwok: { serviceDomain: "cluster.local" } }));
    const diags = wk8501.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("prod-cluster");
    expect(diags[0].message).toContain('unknown field "spec.clusterNetwok"');
    expect(diags[0].message).toContain('did you mean "clusterNetwork"');
    // WK8502 has nothing to say about a field the schema does not know.
    expect(wk8502.check(ctx).length).toBe(0);
  });

  test.skipIf(!hasLexicon)("WK8502 flags a wrong-typed scalar and an out-of-enum value on CAPI Cluster", () => {
    const ctx = manifestsCtx(capiCluster({
      paused: "yes",
      availabilityGates: [{ conditionType: "Ready", polarity: "Postive" }],
    }));
    const diags = wk8502.check(ctx);
    const messages = diags.map((d) => d.message);
    expect(messages).toEqual([
      expect.stringContaining('"spec.paused" expects a boolean, got string "yes"'),
      expect.stringContaining('"spec.availabilityGates[0].polarity" must be one of "Positive", "Negative", got string "Postive"'),
    ]);
    expect(diags.every((d) => d.checkId === "WK8502" && d.severity === "error")).toBe(true);
    expect(wk8501.check(ctx).length).toBe(0);
  });

  test.skipIf(!hasLexicon)("WK8501 flags a misspelled ACK S3 Bucket field and suggests the real one", () => {
    const ctx = manifestsCtx(ackBucket({ nmae: "build-artifacts", objectLockEnabledForBucket: true }));
    const diags = wk8501.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("build-artifacts");
    expect(diags[0].message).toContain('unknown field "spec.nmae"');
    expect(diags[0].message).toContain('did you mean "name"');
    expect(wk8502.check(ctx).length).toBe(0);
  });

  test.skipIf(!hasLexicon)("WK8502 flags a wrong-typed scalar on ACK S3 Bucket", () => {
    const ctx = manifestsCtx(ackBucket({ name: "build-artifacts", objectLockEnabledForBucket: "true" }));
    const diags = wk8502.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8502");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain('"spec.objectLockEnabledForBucket" expects a boolean, got string "true"');
    expect(wk8501.check(ctx).length).toBe(0);
  });

  test("built-in kinds and unknown apiVersion/kind pairs are never checked", () => {
    const ctx = manifestsCtx(
      { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { replicas: "2", bogus: true } },
      { apiVersion: "example.com/v1", kind: "Widget", metadata: { name: "w" }, spec: { bogus: true } },
    );
    expect(wk8501.check(ctx)).toEqual([]);
    expect(wk8502.check(ctx)).toEqual([]);
  });

  test("open objects and int-or-string accept anything (stub registry)", () => {
    setCrdSchemaRegistry(new Map([[
      "example.com/v1/Widget",
      {
        type: "object",
        fields: {
          labels: { type: "object", open: true },
          port: { open: true },
          replicas: { type: "integer" },
          items: { type: "array", items: { type: "string" } },
        },
      },
    ]]));
    try {
      const ok = manifestsCtx({
        apiVersion: "example.com/v1", kind: "Widget", metadata: { name: "w" },
        spec: { labels: { anything: { nested: true } }, port: "http", replicas: 2, items: ["a"] },
      });
      expect(wk8501.check(ok)).toEqual([]);
      expect(wk8502.check(ok)).toEqual([]);

      const bad = manifestsCtx({
        apiVersion: "example.com/v1", kind: "Widget", metadata: { name: "w" },
        spec: { replicas: 2.5, items: "a" },
      });
      expect(wk8502.check(bad).map((d) => d.message)).toEqual([
        expect.stringContaining('"spec.replicas" expects an integer, got number 2.5'),
        expect.stringContaining('"spec.items" expects an array, got string "a"'),
      ]);
    } finally {
      setCrdSchemaRegistry(null);
    }
  });

  test("validateSpec reports unknown fields and type mismatches with dotted paths", () => {
    const schema = { type: "object" as const, fields: { a: { type: "object" as const, fields: { b: { type: "boolean" as const } } } } };
    expect(validateSpec({ a: { b: "x", c: 1 }, d: 2 }, schema)).toEqual([
      { kind: "type-mismatch", path: "spec.a.b", message: expect.stringContaining("expects a boolean") },
      { kind: "unknown-field", path: "spec.a.c", message: expect.stringContaining('unknown field "spec.a.c"') },
      { kind: "unknown-field", path: "spec.d", message: expect.stringContaining('unknown field "spec.d"') },
    ]);
  });
});

// ── WK8503: consumed-but-unproduced Secret ──────────────────────────

describe("WK8503: workload consumes a Secret nothing in the output produces", () => {
  function appConsuming(name: string) {
    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app", namespace: "web" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "app:1.0", envFrom: [{ secretRef: { name } }] },
            ],
          },
        },
      },
    };
  }

  /** Like manifestsCtx, but with SecretProvenance declarations discovered as entities. */
  function ctxWithDeclarations(decls: SecretDeclarationInput[], ...objs: unknown[]): PostSynthContext {
    const ctx = manifestsCtx(...objs);
    decls.forEach((d, i) => ctx.entities.set(`secretDecl${i}`, declareSecret(d as never)));
    return ctx;
  }

  test("metadata", () => {
    expect(wk8503.id).toBe("WK8503");
  });

  test("fires when nothing produces the consumed Secret", () => {
    const diags = wk8503.check(manifestsCtx(appConsuming("fountain-secrets")));
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8503");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("app");
    expect(diags[0].message).toContain('Secret "fountain-secrets"');
    expect(diags[0].message).toContain("envFrom.secretRef");
  });

  test("quiet when a Secret manifest in the output produces it", () => {
    const ctx = manifestsCtx(
      appConsuming("fountain-secrets"),
      { apiVersion: "v1", kind: "Secret", metadata: { name: "fountain-secrets", namespace: "web" }, stringData: {} },
    );
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("quiet when an ExternalSecret materializes the target name", () => {
    const ctx = manifestsCtx(
      appConsuming("fountain-secrets"),
      {
        apiVersion: "external-secrets.io/v1",
        kind: "ExternalSecret",
        metadata: { name: "fountain-secrets-eso", namespace: "web" },
        spec: {
          secretStoreRef: { name: "store", kind: "ClusterSecretStore" },
          target: { name: "fountain-secrets", creationPolicy: "Owner" },
          data: [],
        },
      },
    );
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("an ExternalSecret with no explicit target produces its own name", () => {
    const ctx = manifestsCtx(
      appConsuming("fountain-secrets"),
      {
        apiVersion: "external-secrets.io/v1",
        kind: "ExternalSecret",
        metadata: { name: "fountain-secrets", namespace: "web" },
        spec: { secretStoreRef: { name: "store", kind: "ClusterSecretStore" }, data: [] },
      },
    );
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("quiet when an InfisicalSecret's managedSecretReference produces it", () => {
    const ctx = manifestsCtx(
      appConsuming("fountain-secrets"),
      {
        apiVersion: "secrets.infisical.com/v1alpha1",
        kind: "InfisicalSecret",
        metadata: { name: "fountain-sync", namespace: "infisical-operator" },
        spec: {
          managedSecretReference: { secretName: "fountain-secrets", secretNamespace: "web" },
        },
      },
    );
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("an InfisicalSecret targeting a different namespace does not cover the consumer", () => {
    const ctx = manifestsCtx(
      appConsuming("fountain-secrets"),
      {
        apiVersion: "secrets.infisical.com/v1alpha1",
        kind: "InfisicalSecret",
        metadata: { name: "fountain-sync", namespace: "web" },
        spec: {
          managedSecretReference: { secretName: "fountain-secrets", secretNamespace: "other" },
        },
      },
    );
    expect(wk8503.check(ctx).length).toBe(1);
  });

  test("quiet when a cert-manager Certificate materializes the secretName", () => {
    const consumer = {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { name: "db", namespace: "web" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "db", image: "db:1" }],
            volumes: [{ name: "tls", secret: { secretName: "db-tls" } }],
          },
        },
      },
    };
    const ctx = manifestsCtx(consumer, {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "db-cert", namespace: "web" },
      spec: { secretName: "db-tls", issuerRef: { name: "issuer" } },
    });
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("a `referenced` provenance declaration waives the check", () => {
    const ctx = ctxWithDeclarations(
      [{ name: "fountain-secrets", provenance: "referenced", scope: "minted by `just secret`" }],
      appConsuming("fountain-secrets"),
    );
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("a `generated-once` provenance declaration waives the check", () => {
    const ctx = ctxWithDeclarations(
      [{ name: "fountain-secrets", provenance: "generated-once", keys: ["token"] }],
      appConsuming("fountain-secrets"),
    );
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("a declaration covering a different name does not waive the check", () => {
    const ctx = ctxWithDeclarations(
      [{ name: "some-other-secret", provenance: "referenced" }],
      appConsuming("fountain-secrets"),
    );
    const diags = wk8503.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain('"fountain-secrets"');
  });

  test("optional references are skipped", () => {
    const ctx = manifestsCtx({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app", namespace: "web" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1.0",
                envFrom: [{ secretRef: { name: "maybe-env", optional: true } }],
                env: [{ name: "TOKEN", valueFrom: { secretKeyRef: { name: "maybe-key", key: "t", optional: true } } }],
              },
            ],
            volumes: [{ name: "v", secret: { secretName: "maybe-vol", optional: true } }],
          },
        },
      },
    });
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("covers secretKeyRef, projected sources, imagePullSecrets, and initContainers", () => {
    const ctx = manifestsCtx({
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: "sync", namespace: "web" },
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                imagePullSecrets: [{ name: "registry-creds" }],
                initContainers: [
                  { name: "init", image: "i:1", env: [{ name: "T", valueFrom: { secretKeyRef: { name: "api-token", key: "t" } } }] },
                ],
                containers: [{ name: "sync", image: "s:1" }],
                volumes: [
                  { name: "p", projected: { sources: [{ secret: { name: "projected-secret" } }] } },
                ],
              },
            },
          },
        },
      },
    });
    const secrets = wk8503.check(ctx).map((d) => d.message.match(/consumes Secret "([^"]+)"/)?.[1]).sort();
    expect(secrets).toEqual(["api-token", "projected-secret", "registry-creds"]);
  });

  test("a Secret in an explicit different namespace does not cover the consumer", () => {
    const ctx = manifestsCtx(
      appConsuming("fountain-secrets"),
      { apiVersion: "v1", kind: "Secret", metadata: { name: "fountain-secrets", namespace: "other" }, stringData: {} },
    );
    expect(wk8503.check(ctx).length).toBe(1);
  });

  test("a Secret with no namespace covers a namespaced consumer", () => {
    const ctx = manifestsCtx(
      appConsuming("fountain-secrets"),
      { apiVersion: "v1", kind: "Secret", metadata: { name: "fountain-secrets" }, stringData: {} },
    );
    expect(wk8503.check(ctx)).toEqual([]);
  });

  test("reports a missing Secret once per workload even when referenced twice", () => {
    const ctx = manifestsCtx({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app", namespace: "web" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1.0",
                envFrom: [{ secretRef: { name: "fountain-secrets" } }],
                env: [{ name: "T", valueFrom: { secretKeyRef: { name: "fountain-secrets", key: "t" } } }],
              },
            ],
          },
        },
      },
    });
    expect(wk8503.check(ctx).length).toBe(1);
  });
});

// ── WK8504: committed-encrypted declaration does not resolve ─────────
//
// The fixture is a real sops-shaped document (cleartext structure, ENC[...]
// values, an age recipient block, a mac). Nothing here decrypts anything.

describe("WK8504: committed-encrypted secret declaration does not resolve", () => {
  const CIPHERTEXT = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testdata", "sops", "db-credentials.sops.yaml"),
    "utf-8",
  );

  /**
   * A context whose k8s output carries `manifests` in the primary document and
   * the ciphertext as a SIDECAR — the only place the check can find it.
   */
  function sopsCtx(
    opts: { ciphertext?: string; file?: string; declaredName?: string; manifests?: unknown[]; omitSidecar?: boolean } = {},
  ): PostSynthContext {
    const primary = (opts.manifests ?? []).map((o) => JSON.stringify(o)).join("\n---\n");
    const file = opts.file ?? "secrets/db-credentials.sops.yaml";
    const output: SerializerResult = {
      primary,
      files: opts.omitSidecar
        ? {}
        : { "db-credentials.sops.yaml": opts.ciphertext ?? CIPHERTEXT },
    };
    const outputs = new Map<string, string | SerializerResult>([["k8s", output]]);
    const entities = new Map<string, Declarable>([
      [
        "dbCredentials",
        declareSecret({
          name: opts.declaredName ?? "db-credentials",
          provenance: "committed-encrypted",
          file,
          keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"],
        }),
      ],
    ]);
    return {
      outputs,
      entities,
      buildResult: { outputs, entities, warnings: [], errors: [], sourceFileCount: 1 },
    };
  }

  test("metadata", () => {
    expect(wk8504.id).toBe("WK8504");
  });

  test("quiet when the declared file resolved to encrypted ciphertext", () => {
    expect(wk8504.check(sopsCtx())).toEqual([]);
  });

  test("quiet when the project declares no committed-encrypted secret", () => {
    expect(wk8504.check(manifestsCtx({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" } }))).toEqual([]);
  });

  test("fires when the build emitted no file for the declaration", () => {
    const diags = wk8504.check(sopsCtx({ omitSidecar: true }));
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WK8504");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("db-credentials");
    expect(diags[0].message).toContain("secrets/db-credentials.sops.yaml");
    expect(diags[0].message).toContain("did not resolve");
  });

  test("fires when metadata.name disagrees with the declaration", () => {
    const diags = wk8504.check(sopsCtx({ declaredName: "other-credentials" }));
    // The name mismatch; the sidecar filename still matches, so it is found.
    expect(diags.some((d) => /metadata\.name "db-credentials"/.test(d.message))).toBe(true);
  });

  test("fires when the document carries no sops block", () => {
    const decrypted = CIPHERTEXT.slice(0, CIPHERTEXT.indexOf("sops:"));
    const diags = wk8504.check(sopsCtx({ ciphertext: decrypted }));
    expect(diags.some((d) => /no top-level `sops` block/.test(d.message))).toBe(true);
  });

  test("fires when a data value is not ENC[...], naming the key and not the value", () => {
    const leaked = CIPHERTEXT.replace(/POSTGRES_PASSWORD: ENC\[[^\]]*\]/, "POSTGRES_PASSWORD: hunter2");
    const diags = wk8504.check(sopsCtx({ ciphertext: leaked }));
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain('stringData."POSTGRES_PASSWORD" is not encrypted');
    expect(diags[0].message).not.toContain("hunter2");
  });

  test("reports every problem on a declaration at once", () => {
    const broken = CIPHERTEXT.replace("kind: Secret", "kind: ConfigMap").replace(
      /POSTGRES_USER: ENC\[[^\]]*\]/,
      "POSTGRES_USER: postgres",
    );
    expect(wk8504.check(sopsCtx({ ciphertext: broken })).length).toBeGreaterThanOrEqual(2);
  });

  test("post-synth checks that read only the primary output stay blind to the sidecar", () => {
    // The ciphertext must never reach the primary output — that is what makes
    // applying an undecrypted Secret structurally impossible — so the rules
    // that look for hardcoded material see nothing here.
    const ctx = sopsCtx({ manifests: [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "app" } }] });
    expect(wk8005.check(ctx)).toEqual([]);
    expect(wk8041.check(ctx)).toEqual([]);
    expect(wk8042.check(ctx)).toEqual([]);
  });

  describe("WK8503 is satisfied through the producer set, not the waiver set", () => {
    function consumerIn(namespace: string) {
      return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "api", namespace },
        spec: {
          template: {
            spec: {
              containers: [
                { name: "api", image: "api:1.0", envFrom: [{ secretRef: { name: "db-credentials" } }] },
              ],
            },
          },
        },
      };
    }

    test("a resolved declaration produces the Secret in its own namespace", () => {
      // The fixture is `namespace: apps`, read from the ciphertext itself.
      expect(wk8503.check(sopsCtx({ manifests: [consumerIn("apps")] }))).toEqual([]);
    });

    test("namespace matching applies — another namespace is not covered", () => {
      const diags = wk8503.check(sopsCtx({ manifests: [consumerIn("platform")] }));
      expect(diags.length).toBe(1);
      expect(diags[0].message).toContain('Secret "db-credentials"');
    });

    test("a declaration whose file did not resolve waives nothing", () => {
      const ctx = sopsCtx({ omitSidecar: true, manifests: [consumerIn("apps")] });
      expect(wk8504.check(ctx).length).toBe(1);
      expect(wk8503.check(ctx).length).toBe(1);
    });

    test("a declaration whose ciphertext is not encrypted waives nothing", () => {
      const leaked = CIPHERTEXT.replace(/POSTGRES_USER: ENC\[[^\]]*\]/, "POSTGRES_USER: postgres");
      const ctx = sopsCtx({ ciphertext: leaked, manifests: [consumerIn("apps")] });
      expect(wk8504.check(ctx).length).toBe(1);
      expect(wk8503.check(ctx).length).toBe(1);
    });
  });
});
