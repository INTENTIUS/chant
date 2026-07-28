/**
 * Test doubles for the one seam this package exposes.
 *
 * A fake here replaces `@kubernetes/client-node`'s HTTP send and nothing
 * above it: the handler receives the real, fully built request — the URL the
 * client constructed from discovery, the method, and the headers the
 * kubeconfig's auth path wrote, `Authorization` included. So a test that uses
 * it still exercises kubeconfig parsing, context selection, credential policy,
 * discovery and path construction for real.
 *
 * It exists in the shipped package rather than in a test helper because both
 * this package's tests and the k8s lexicon's tests need it, and because a
 * consumer wiring chant into their own harness needs the same thing.
 */

import type { RequestContextLike, RequestLayer, ResponseContextLike } from "./types";

/** What a {@link FakeRequestHandler} sees. */
export interface RecordedRequest {
  method: string;
  /** Full URL including query string. */
  url: string;
  /** Path only, query stripped. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

/** What a handler returns. `body` is stringified when it is not already a string. */
export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type FakeRequestHandler = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

/** A recording {@link RequestLayer} driven by `handler`. */
export interface FakeRequestLayer extends RequestLayer {
  /** Every request the client issued, in order. */
  readonly requests: RecordedRequest[];
  /** Paths only, in order — the usual assertion target. */
  paths(): string[];
}

/**
 * Build a fake request layer. Anything the handler does not answer 200s with
 * an empty object, so a test only has to describe the responses it cares about.
 */
export function fakeRequestLayer(handler: FakeRequestHandler): FakeRequestLayer {
  const requests: RecordedRequest[] = [];

  return {
    requests,
    paths: () => requests.map((r) => r.path),
    async send(request: RequestContextLike): Promise<ResponseContextLike> {
      const url = request.getUrl();
      const parsed = new URL(url, "http://placeholder.invalid");
      const recorded: RecordedRequest = {
        method: String(request.getHttpMethod()),
        url,
        path: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams.entries()),
        headers: request.getHeaders(),
        body: request.getBody(),
      };
      requests.push(recorded);

      const result = await handler(recorded);
      const status = result.status ?? 200;
      const body =
        result.body === undefined ? "" : typeof result.body === "string" ? result.body : JSON.stringify(result.body);
      return {
        httpStatusCode: status,
        headers: { "content-type": "application/json", ...(result.headers ?? {}) },
        body: { text: async () => body },
      };
    },
  };
}

/** A Kubernetes `Status` failure body, for driving typed-error assertions. */
export function statusBody(code: number, reason: string, message: string): Record<string, unknown> {
  return {
    kind: "Status",
    apiVersion: "v1",
    metadata: {},
    status: "Failure",
    message,
    reason,
    code,
  };
}

/** Options for {@link fakeKubeconfig}. */
export interface FakeKubeconfigOptions {
  contexts?: Array<{ name: string; cluster?: string; user?: string; namespace?: string }>;
  currentContext?: string;
  server?: string;
  /** Static bearer token. Mutually exclusive with `exec` in practice. */
  token?: string;
  /** An exec credential plugin stanza, for allowlist and caching tests. */
  exec?: { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
}

/**
 * A literal kubeconfig, so no test ever reads the developer's real one. Every
 * test in this repo that builds a client passes one of these.
 */
export function fakeKubeconfig(options: FakeKubeconfigOptions = {}): string {
  const server = options.server ?? "https://cluster.test:6443";
  const contexts = options.contexts ?? [{ name: "test-context" }];
  const current = options.currentContext ?? contexts[0].name;
  const userStanza = options.exec
    ? [
        "      exec:",
        "        apiVersion: client.authentication.k8s.io/v1",
        `        command: ${JSON.stringify(options.exec.command)}`,
        ...(options.exec.args?.length
          ? ["        args:", ...options.exec.args.map((a) => `          - ${JSON.stringify(a)}`)]
          : []),
        ...(options.exec.env?.length
          ? [
              "        env:",
              ...options.exec.env.flatMap((e) => [
                `          - name: ${e.name}`,
                `            value: ${JSON.stringify(e.value)}`,
              ]),
            ]
          : []),
      ]
    : [`      token: ${JSON.stringify(options.token ?? "test-token")}`];

  const users = [...new Set(contexts.map((c) => c.user ?? "test-user"))];
  const clusters = [...new Set(contexts.map((c) => c.cluster ?? "test-cluster"))];

  return [
    "apiVersion: v1",
    "kind: Config",
    `current-context: ${current}`,
    "clusters:",
    ...clusters.flatMap((name) => [
      `  - name: ${name}`,
      "    cluster:",
      `      server: ${server}`,
      "      insecure-skip-tls-verify: true",
    ]),
    "users:",
    ...users.flatMap((name) => [`  - name: ${name}`, "    user:", ...userStanza]),
    "contexts:",
    ...contexts.flatMap((c) => [
      `  - name: ${c.name}`,
      "    context:",
      `      cluster: ${c.cluster ?? "test-cluster"}`,
      `      user: ${c.user ?? "test-user"}`,
      ...(c.namespace ? [`      namespace: ${c.namespace}`] : []),
    ]),
    "",
  ].join("\n");
}

/** An `APIResourceList` body, the discovery response the client resolves against. */
export function apiResourceList(
  groupVersion: string,
  resources: Array<{
    name: string;
    kind: string;
    namespaced?: boolean;
    singularName?: string;
    shortNames?: string[];
    verbs?: string[];
  }>,
): Record<string, unknown> {
  return {
    kind: "APIResourceList",
    apiVersion: "v1",
    groupVersion,
    resources: resources.map((r) => ({
      name: r.name,
      singularName: r.singularName ?? "",
      namespaced: r.namespaced ?? true,
      kind: r.kind,
      verbs: r.verbs ?? ["get", "list", "watch", "create", "update", "patch", "delete"],
      ...(r.shortNames ? { shortNames: r.shortNames } : {}),
    })),
  };
}
