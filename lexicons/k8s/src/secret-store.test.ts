/**
 * The k8s SecretStoreAdapter (chant #1830) over the fake cluster — a real
 * `@intentius/chant-k8s-client` with only the HTTP send replaced, the same
 * harness the teardown and prune suites use.
 *
 * What is asserted is the constitutional line as much as the behavior: no
 * return value and no log line of the read half ever carries a `data` value,
 * and the write half consumes each key's material exactly once, at the write,
 * with the ownership marker and the generated-once label stamped on.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import {
  SecretMaterial,
  consumeSecretMaterial,
  ensureSecretMaterialization,
  SecretContractMismatchError,
} from "@intentius/chant/secret-materialization";
import { LABEL_OWNERSHIP_KEYS, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import type { RecordedRequest } from "@intentius/chant-k8s-client/testing";
import { fakeCluster, objectKey } from "./api/fake-cluster";
import { k8sSecretStore } from "./secret-store";
import { GENERATED_ONCE_LABEL_KEY, GENERATED_ONCE_LABEL_VALUE } from "./secret-labels";

const PLAINTEXT_A = "plain-material-alpha";
const PLAINTEXT_B = "plain-material-bravo";
const LIVE_VALUE_1 = Buffer.from("live-master-bytes", "utf-8").toString("base64");
const LIVE_VALUE_2 = Buffer.from("live-conf-bytes", "utf-8").toString("base64");

/** Every string no read-path return or log may ever contain. */
const FORBIDDEN = [PLAINTEXT_A, PLAINTEXT_B, LIVE_VALUE_1, LIVE_VALUE_2, "live-master-bytes", "live-conf-bytes"];

function liveSecret(): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "master-key",
      namespace: "prod",
      uid: "uid-master-key",
      labels: {
        [LABEL_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE,
        [GENERATED_ONCE_LABEL_KEY]: GENERATED_ONCE_LABEL_VALUE,
      },
      annotations: { "example.com/note": "hand-written" },
    },
    type: "Opaque",
    data: { MASTER_KEY: LIVE_VALUE_1, "app.conf": LIVE_VALUE_2 },
  };
}

function clusterWithSecret() {
  return fakeCluster({
    objects: { [objectKey("v1", "Secret", "master-key", "prod")]: liveSecret() },
    respond: (req: RecordedRequest) => (req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined),
  });
}

async function clientOf(cluster: ReturnType<typeof fakeCluster>): Promise<K8sClient> {
  return (await cluster.connector({})).client;
}

/** Spies on every console channel; returns everything logged as one string. */
function spyConsole(): { flush: () => string } {
  const calls: unknown[][] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
  }
  return { flush: () => calls.flat().map(String).join("\n") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("k8sSecretStore — the read half never returns or logs a value", () => {
  test("exists answers presence and nothing else", async () => {
    const cluster = clusterWithSecret();
    const store = k8sSecretStore("prod", await clientOf(cluster));
    await expect(store.exists("master-key")).resolves.toBe(true);
    await expect(store.exists("absent")).resolves.toBe(false);
  });

  test("describe projects key NAMES and labels/annotations, never data values", async () => {
    const cluster = clusterWithSecret();
    const spy = spyConsole();
    const store = k8sSecretStore("prod", await clientOf(cluster));

    const description = await store.describe("master-key");

    expect(description.keys).toEqual(["MASTER_KEY", "app.conf"]);
    expect(description.metadata?.[GENERATED_ONCE_LABEL_KEY]).toBe(GENERATED_ONCE_LABEL_VALUE);
    expect(description.metadata?.["example.com/note"]).toBe("hand-written");
    // The claim that matters: nothing value-shaped in the return, under any
    // key — the description carries exactly `keys` and `metadata`, and no
    // byte of the stored values appears anywhere in its serialization.
    expect(Object.keys(description).sort()).toEqual(["keys", "metadata"]);
    const serialized = JSON.stringify(description);
    for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden);
    for (const forbidden of FORBIDDEN) expect(spy.flush()).not.toContain(forbidden);
  });

  test("ensureSecretMaterialization over the adapter: present-and-matching writes nothing", async () => {
    const cluster = clusterWithSecret();
    const store = k8sSecretStore("prod", await clientOf(cluster));
    const outcome = await ensureSecretMaterialization(store, {
      name: "master-key",
      keys: ["MASTER_KEY", "app.conf"],
    });
    expect(outcome).toEqual({ outcome: "present", name: "master-key", keys: ["MASTER_KEY", "app.conf"] });
    expect(cluster.layer.requests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  test("a key-set mismatch fails loudly naming key names, never values", async () => {
    const cluster = clusterWithSecret();
    const store = k8sSecretStore("prod", await clientOf(cluster));
    const err = await ensureSecretMaterialization(store, {
      name: "master-key",
      keys: ["MASTER_KEY", "MISSING_KEY"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretContractMismatchError);
    const message = String((err as Error).message);
    expect(message).toContain("MISSING_KEY");
    expect(message).toContain("app.conf");
    for (const forbidden of FORBIDDEN) expect(message).not.toContain(forbidden);
  });
});

describe("k8sSecretStore — create consumes material at the write and stamps the markers", () => {
  test("mints one value per key, consumes each handle exactly once, stamps ownership + generated-once", async () => {
    const cluster = fakeCluster({
      respond: (req: RecordedRequest) => (req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined),
    });
    const minted: SecretMaterial[] = [];
    const generate = vi.fn((key: string) => {
      const handle = SecretMaterial.mint(key === "MASTER_KEY" ? PLAINTEXT_A : PLAINTEXT_B);
      minted.push(handle);
      return handle;
    });

    const store = k8sSecretStore("prod", await clientOf(cluster), {
      marker: { stack: "shop", env: "dev" },
    });
    const outcome = await ensureSecretMaterialization(
      store,
      { name: "master-key", keys: ["MASTER_KEY", "SECOND_KEY"] },
      generate,
    );
    expect(outcome).toEqual({ outcome: "created", name: "master-key", keys: ["MASTER_KEY", "SECOND_KEY"] });

    // One mint per declared key, and every handle burned at the write: a
    // second consume of any of them throws.
    expect(generate).toHaveBeenCalledTimes(2);
    for (const handle of minted) {
      expect(() => consumeSecretMaterial(handle)).toThrow(/already consumed/);
    }

    const patch = cluster.layer.requests.find((r) => r.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.path).toBe("/api/v1/namespaces/prod/secrets/master-key");
    expect(patch!.query.fieldManager).toBe("chant:shop");
    const body = JSON.parse(String(patch!.body)) as K8sObject;
    expect(body.metadata?.labels).toEqual({
      [LABEL_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE,
      [LABEL_OWNERSHIP_KEYS.stack]: "shop",
      [LABEL_OWNERSHIP_KEYS.env]: "dev",
      [GENERATED_ONCE_LABEL_KEY]: GENERATED_ONCE_LABEL_VALUE,
    });
    expect(body.data).toEqual({
      MASTER_KEY: Buffer.from(PLAINTEXT_A, "utf-8").toString("base64"),
      SECOND_KEY: Buffer.from(PLAINTEXT_B, "utf-8").toString("base64"),
    });
  });

  test("the handle itself never leaks material: stringify/inspect show only the redaction marker", () => {
    const handle = SecretMaterial.mint(PLAINTEXT_A);
    expect(String(handle)).not.toContain(PLAINTEXT_A);
    expect(JSON.stringify({ handle })).not.toContain(PLAINTEXT_A);
    consumeSecretMaterial(handle); // leave no live handle behind
  });
});
