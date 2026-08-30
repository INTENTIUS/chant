/**
 * `chant lifecycle whoami` for Kubernetes (chant #1982).
 *
 * Every case drives the real client against a literal kubeconfig with the
 * transport faked, so no ambient kubeconfig is read and no cluster is
 * contacted. The load-bearing case is the last one: whoami and
 * `describeResources` must resolve the same cluster, or the report describes a
 * binding the read does not use.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const loadChantConfigMock = vi.fn();
vi.mock("@intentius/chant/config", () => ({
  loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
}));

const { describeIdentity } = await import("./whoami");
const { describeResources } = await import("./describe-resources");
const { fakeCluster, objectKey } = await import("./api/fake-cluster");
const { defaultK8sConnector } = await import("./api/connect");
const { fakeKubeconfig, statusBody } = await import("@intentius/chant-k8s-client/testing");
import type { RecordedRequest } from "@intentius/chant-k8s-client/testing";
import type { ResolvedIdentity, UnresolvedIdentity } from "@intentius/chant/lexicon";

const REVIEW_V1 = "/apis/authentication.k8s.io/v1/selfsubjectreviews";

/** The API server's own answer to "who am I". */
function reviewResponse(username: string): { body: Record<string, unknown> } {
  return {
    body: {
      apiVersion: "authentication.k8s.io/v1",
      kind: "SelfSubjectReview",
      status: { userInfo: { username, groups: ["system:authenticated"] } },
    },
  };
}

const twoContexts = fakeKubeconfig({
  contexts: [
    { name: "prod-eks", cluster: "prod", user: "prod-user", namespace: "chant" },
    { name: "staging-eks", cluster: "staging", user: "staging-user" },
  ],
  currentContext: "staging-eks",
  server: "https://cluster.test:6443",
});

const resolved = (r: unknown): ResolvedIdentity => r as ResolvedIdentity;
const refusal = (r: unknown): UnresolvedIdentity => (r as { unresolved: UnresolvedIdentity }).unresolved;

describe("k8s describeIdentity (#1982)", () => {
  beforeEach(() => {
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
  });

  test("reports the API server's subject, the bound context as scope, and the binding as source", async () => {
    loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
    const cluster = fakeCluster({
      kubeconfig: twoContexts,
      respond: (req: RecordedRequest) => (req.path === REVIEW_V1 ? reviewResponse("system:serviceaccount:chant:deployer") : undefined),
    });

    const result = resolved(
      await describeIdentity({ environment: "prod" }, (o) =>
        defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      ),
    );

    expect(result.identity).toBe("system:serviceaccount:chant:deployer");
    expect(result.scope).toBe("prod-eks ns=chant");
    expect(result.source).toContain("k8s.profiles.prod.context");
    expect(result.source).toContain("credential token");
    expect(result.endpoint).toBe("https://cluster.test:6443");
  });

  test("an unbound environment says which binding is missing rather than staying quiet", async () => {
    const cluster = fakeCluster({
      kubeconfig: twoContexts,
      respond: (req: RecordedRequest) => (req.path === REVIEW_V1 ? reviewResponse("kubernetes-admin") : undefined),
    });

    const result = resolved(
      await describeIdentity({ environment: "prod" }, (o) =>
        defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      ),
    );

    expect(result.identity).toBe("kubernetes-admin");
    expect(result.scope).toContain("staging-eks");
    expect(result.source).toContain("no k8s.profiles.prod binding");
  });

  test("a cluster with no review API is 'could not determine', not the kubeconfig's local alias", async () => {
    // The kubeconfig user is `prod-user` here. Reporting that as the identity
    // would be a guess: the cluster maps a credential onto whatever subject it
    // likes, which is the whole reason the question is worth asking.
    loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
    const cluster = fakeCluster({ kubeconfig: twoContexts });

    const result = refusal(
      await describeIdentity({ environment: "prod" }, (o) =>
        defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      ),
    );

    expect(result.reason).toBe("read-failed");
    expect(result.detail).toContain("SelfSubjectReview");
    expect(result.detail).toContain("local credential entry");
  });

  test("a refused review is no-credentials, keeping it apart from a broken one", async () => {
    const cluster = fakeCluster({
      kubeconfig: twoContexts,
      respond: (req: RecordedRequest) =>
        req.path === REVIEW_V1
          ? { status: 403, body: statusBody(403, "Forbidden", "selfsubjectreviews is forbidden") }
          : undefined,
    });

    const result = refusal(
      await describeIdentity({ environment: "prod" }, (o) =>
        defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      ),
    );
    expect(result.reason).toBe("no-credentials");
  });

  test("a binding naming a context the kubeconfig does not have is no-binding", async () => {
    loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "missing-eks" } } } } });
    const cluster = fakeCluster({ kubeconfig: twoContexts });

    const result = refusal(
      await describeIdentity({ environment: "prod" }, (o) =>
        defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      ),
    );
    expect(result.reason).toBe("no-binding");
    expect(result.detail).toContain("missing-eks");
  });

  test("the credential is named, never printed", async () => {
    const withToken = fakeKubeconfig({ token: "a-static-bearer-token-value" });
    const cluster = fakeCluster({
      kubeconfig: withToken,
      respond: (req: RecordedRequest) => (req.path === REVIEW_V1 ? reviewResponse("ci@acme.example") : undefined),
    });

    const result = await describeIdentity({ environment: "prod" }, (o) =>
      defaultK8sConnector({ ...o, client: { kubeconfig: withToken, requestLayer: cluster.layer } }),
    );
    // A kubeconfig holding a static token is the case where the identity
    // signal IS a secret. The report says `credential token` and stops.
    expect(resolved(result).source).toContain("credential token");
    expect(JSON.stringify(result)).not.toContain("a-static-bearer-token-value");
  });
});

describe("whoami and the live read resolve the same cluster (#1982 acceptance)", () => {
  test("the reported endpoint is the server describeResources reads against", async () => {
    loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
    const web = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "chant", uid: "uid-1", resourceVersion: "7" },
      status: { readyReplicas: 1, replicas: 1 },
    };
    const cluster = fakeCluster({
      kubeconfig: twoContexts,
      objects: { [objectKey("apps/v1", "Deployment", "web", "chant")]: web },
      respond: (req: RecordedRequest) => (req.path === REVIEW_V1 ? reviewResponse("system:serviceaccount:chant:deployer") : undefined),
    });
    const connects: Array<string | undefined> = [];
    const connect = (o: Parameters<typeof defaultK8sConnector>[0]) => {
      connects.push(o.environment);
      return defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } });
    };

    const identity = resolved(await describeIdentity({ environment: "prod" }, connect));
    const reviewUrl = cluster.layer.requests.find((r) => r.path === REVIEW_V1)!.url;

    cluster.layer.requests.length = 0;
    const observed = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: new Map([["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "chant" } } }]]),
      },
      connect,
    );
    expect(observed.resources.web).toBeDefined();

    const origin = (url: string): string => new URL(url).origin;
    expect(origin(reviewUrl)).toBe(identity.endpoint);
    for (const request of cluster.layer.requests) {
      expect(origin(request.url)).toBe(identity.endpoint);
    }
    // Both connect calls resolved the same environment through the same
    // connector, so the binding cannot diverge between the two.
    expect(connects).toEqual(["prod", "prod"]);
  });
});
