import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { k3s101 } from "./k3s101";
import { k3s102 } from "./k3s102";
import { k3s103 } from "./k3s103";
import { k3s104 } from "./k3s104";
import { k3s105 } from "./k3s105";
import { k3s106 } from "./k3s106";
import { k3s107 } from "./k3s107";

function makeCtx(entities: Record<string, { entityType: string; props: Record<string, unknown> }>): PostSynthContext {
  return {
    outputs: new Map(),
    entities: new Map(Object.entries(entities)),
  } as unknown as PostSynthContext;
}

describe("K3S101: literal secret in a config entity", () => {
  test("flags a literal token on a server", () => {
    const diags = k3s101.check(
      makeCtx({ cp: { entityType: "K3s::Server", props: { token: "hunter2" } } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3S101");
    expect(diags[0].severity).toBe("error");
  });

  test("flags an etcd S3 secret key", () => {
    const diags = k3s101.check(
      makeCtx({ cp: { entityType: "K3s::Server", props: { "etcd-s3-secret-key": "shh" } } }),
    );
    expect(diags).toHaveLength(1);
  });

  test("passes token-file and an agent token on the agent side", () => {
    const diags = k3s101.check(
      makeCtx({
        cp: { entityType: "K3s::Server", props: { "token-file": "/etc/rancher/k3s/token" } },
        worker: { entityType: "K3s::Agent", props: { server: "https://cp:6443", "token-file": "/t" } },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("K3S102: literal registry credential", () => {
  test("flags a literal password", () => {
    const diags = k3s102.check(
      makeCtx({
        registries: {
          entityType: "K3s::Registries",
          props: { configs: { "registry.example.com": { auth: { username: "u", password: "p" } } } },
        },
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3S102");
  });

  test("passes username-only auth and TLS file paths", () => {
    const diags = k3s102.check(
      makeCtx({
        registries: {
          entityType: "K3s::Registries",
          props: {
            configs: { "registry.example.com": { auth: { username: "u" }, tls: { ca_file: "/ca" } } },
          },
        },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("K3S103: agent with no server", () => {
  test("flags an agent that joins nothing", () => {
    const diags = k3s103.check(makeCtx({ worker: { entityType: "K3s::Agent", props: {} } }));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3S103");
  });

  test("passes an agent with a server, and ignores servers entirely", () => {
    const diags = k3s103.check(
      makeCtx({
        worker: { entityType: "K3s::Agent", props: { server: "https://cp:6443" } },
        cp: { entityType: "K3s::Server", props: {} },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("K3S104: kubeconfig mode wider than 0644", () => {
  test("flags 0666", () => {
    const diags = k3s104.check(
      makeCtx({ cp: { entityType: "K3s::Server", props: { "write-kubeconfig-mode": "0666" } } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("passes 0600, 0644, and an unset mode", () => {
    const diags = k3s104.check(
      makeCtx({
        a: { entityType: "K3s::Server", props: { "write-kubeconfig-mode": "0600" } },
        b: { entityType: "K3s::Server", props: { "write-kubeconfig-mode": "0644" } },
        c: { entityType: "K3s::Server", props: {} },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("K3S105: TLS verification disabled for a registry", () => {
  test("flags insecure_skip_verify", () => {
    const diags = k3s105.check(
      makeCtx({
        registries: {
          entityType: "K3s::Registries",
          props: { configs: { "registry.example.com": { tls: { insecure_skip_verify: true } } } },
        },
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3S105");
  });

  test("passes a pinned CA", () => {
    const diags = k3s105.check(
      makeCtx({
        registries: {
          entityType: "K3s::Registries",
          props: { configs: { "registry.example.com": { tls: { ca_file: "/ca" } } } },
        },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("K3S106: tls-san missing for a declared bind/advertise address", () => {
  test("flags bind-address with no tls-san", () => {
    const diags = k3s106.check(
      makeCtx({ cp: { entityType: "K3s::Server", props: { "bind-address": "10.0.0.10" } } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3S106");
    expect(diags[0].severity).toBe("warning");
  });

  test("flags advertise-address with no tls-san", () => {
    const diags = k3s106.check(
      makeCtx({ cp: { entityType: "K3s::Server", props: { "advertise-address": "10.0.0.20" } } }),
    );
    expect(diags).toHaveLength(1);
  });

  test("passes bind-address with tls-san set, and neither address declared", () => {
    const diags = k3s106.check(
      makeCtx({
        a: {
          entityType: "K3s::Server",
          props: { "bind-address": "10.0.0.10", "tls-san": ["10.0.0.10"] },
        },
        b: { entityType: "K3s::Server", props: {} },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("K3S107: disabled component still configured", () => {
  test("flags servicelb-namespace with servicelb disabled", () => {
    const diags = k3s107.check(
      makeCtx({
        cp: {
          entityType: "K3s::Server",
          props: { disable: ["servicelb"], "servicelb-namespace": "kube-system" },
        },
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("K3S107");
    expect(diags[0].severity).toBe("warning");
  });

  test("flags cluster-dns with coredns disabled, and default-local-storage-path with local-storage disabled", () => {
    const diags = k3s107.check(
      makeCtx({
        cp: {
          entityType: "K3s::Server",
          props: {
            disable: ["coredns", "local-storage"],
            "cluster-dns": "10.43.0.10",
            "default-local-storage-path": "/data",
          },
        },
      }),
    );
    expect(diags).toHaveLength(2);
  });

  test("passes disabling traefik (no server flag configures it) and unrelated config", () => {
    const diags = k3s107.check(
      makeCtx({
        cp: {
          entityType: "K3s::Server",
          props: { disable: ["traefik"], "tls-san": ["10.0.0.10"] },
        },
      }),
    );
    expect(diags).toHaveLength(0);
  });

  test("passes servicelb-namespace with nothing disabled", () => {
    const diags = k3s107.check(
      makeCtx({
        cp: { entityType: "K3s::Server", props: { "servicelb-namespace": "kube-system" } },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});
