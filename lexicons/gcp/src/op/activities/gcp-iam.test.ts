import { beforeEach, describe, expect, test } from "vitest";
import { applyResource, deleteResource, MAPPERS, type GcpHttp, type GcpResource } from "./gcp-apply";
import { iamPolicyMemberMapper, iamTarget, policyHasMember, withMember, withoutMember } from "./gcp-iam";
import { getResource } from "../../api/read-client";

const binding = (overrides: Record<string, unknown> = {}): GcpResource => ({
  kind: "IAMPolicyMember",
  metadata: { name: "web-public" },
  spec: {
    member: "allUsers",
    role: "roles/run.invoker",
    resourceRef: { apiVersion: "run.cnrm.cloud.google.com/v1beta1", kind: "RunService", name: "web" },
    ...overrides,
  },
});

/** A fake policy store: one policy per `:getIamPolicy` path, recording each call. */
function policyServer(initial: Record<string, unknown> = { etag: "e1", bindings: [{ role: "roles/viewer", members: ["user:a@x.io"] }] }) {
  let policy = initial as { etag?: string; bindings?: Array<{ role: string; members: string[] }> };
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let conflicts = 0;
  const http: GcpHttp = async (method, url, body) => {
    calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
    if (url.includes(":getIamPolicy")) return { status: 200, text: JSON.stringify(policy) };
    if (url.includes(":setIamPolicy")) {
      if (conflicts > 0) {
        conflicts--;
        return { status: 409, text: "etag mismatch" };
      }
      policy = { ...(body as { policy: typeof policy }).policy, etag: "e2" };
      return { status: 200, text: JSON.stringify(policy) };
    }
    return { status: 404, text: "" };
  };
  return { http, calls, policy: () => policy, conflict: (n: number) => (conflicts = n) };
}

const ctx = { base: "https://iam.googleapis.com", project: "p1" };

// The region default reads GCP_REGION; pin it so the URLs below hold.
beforeEach(() => {
  delete process.env.GCP_REGION;
});

describe("IAMPolicyMember targets (#4233)", () => {
  test("a RunService takes its region from the manifest, and its host when there is no override", () => {
    const manifest: GcpResource[] = [{ kind: "RunService", metadata: { name: "web" }, spec: { location: "europe-west1" } }];
    const t = iamTarget(binding().spec as never, "p1", manifest)!;
    expect(t.get(t.host)).toEqual({
      method: "GET",
      url: "https://run.googleapis.com/v2/projects/p1/locations/europe-west1/services/web:getIamPolicy?options.requestedPolicyVersion=3",
    });
  });

  test("Project, IAMServiceAccount, StorageBucket, PubSub and secrets resolve; other kinds do not", () => {
    const of = (resourceRef: Record<string, unknown>) => iamTarget({ member: "m", role: "r", resourceRef } as never, "p1");
    expect(of({ kind: "Project", external: "projects/other" })!.path).toBe("projects/other");
    expect(of({ kind: "IAMServiceAccount", name: "sa" })!.path).toBe("projects/p1/serviceAccounts/sa@p1.iam.gserviceaccount.com");
    expect(of({ kind: "StorageBucket", name: "b" })!.set("https://storage.googleapis.com", { bindings: [] })).toEqual({
      method: "PUT",
      url: "https://storage.googleapis.com/storage/v1/b/b/iam",
      body: { bindings: [] },
    });
    expect(of({ kind: "PubSubSubscription", name: "s" })!.path).toBe("projects/p1/subscriptions/s");
    expect(of({ kind: "SecretManagerSecret", name: "k" })!.path).toBe("projects/p1/secrets/k");
    expect(of({ kind: "CloudFunctionsFunction", name: "f" })).toBeUndefined();
  });
});

describe("policy merge (#4233)", () => {
  const spec = { member: "allUsers", role: "roles/run.invoker" };

  test("adds the member to its role and keeps every other binding", () => {
    const next = withMember({ etag: "e1", bindings: [{ role: "roles/viewer", members: ["user:a"] }] }, spec);
    expect(next).toEqual({
      etag: "e1",
      bindings: [
        { role: "roles/viewer", members: ["user:a"] },
        { role: "roles/run.invoker", members: ["allUsers"] },
      ],
    });
    expect(policyHasMember(next, spec)).toBe(true);
  });

  test("a conditional binding is its own binding, at policy version 3", () => {
    const cond = { ...spec, condition: { title: "t", expression: "request.time < timestamp('2030-01-01T00:00:00Z')" } };
    const next = withMember({ bindings: [{ role: "roles/run.invoker", members: ["user:b"] }] }, cond);
    expect(next.version).toBe(3);
    expect(next.bindings).toHaveLength(2);
    expect(policyHasMember(next, spec)).toBe(false);
  });

  test("removing the last member drops the binding", () => {
    expect(withoutMember({ bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] }, spec).bindings).toEqual([]);
  });
});

describe("IAMPolicyMember apply, delete and read (#4233)", () => {
  test("apply reads, merges and writes the policy with its etag, then leaves it alone", async () => {
    const server = policyServer();
    const first = await applyResource(iamPolicyMemberMapper, binding(), ctx, server.http);
    expect(first).toEqual({ kind: "IAMPolicyMember", name: "web-public", created: true, updated: false });
    const set = server.calls.find((c) => c.url.endsWith(":setIamPolicy"))!;
    expect(set.url).toBe("https://run.googleapis.com/v2/projects/p1/locations/us-central1/services/web:setIamPolicy");
    expect((set.body as { policy: { etag: string; bindings: unknown[] } }).policy).toEqual({
      etag: "e1",
      bindings: [
        { role: "roles/viewer", members: ["user:a@x.io"] },
        { role: "roles/run.invoker", members: ["allUsers"] },
      ],
    });
    const again = await applyResource(iamPolicyMemberMapper, binding(), ctx, server.http);
    expect(again.created).toBe(false);
    expect(server.calls.filter((c) => c.url.endsWith(":setIamPolicy"))).toHaveLength(1);
  });

  test("an etag conflict is read again and retried", async () => {
    const server = policyServer();
    server.conflict(1);
    await applyResource(iamPolicyMemberMapper, binding(), ctx, server.http);
    expect(server.calls.filter((c) => c.url.endsWith(":setIamPolicy"))).toHaveLength(2);
    expect(policyHasMember(server.policy(), { member: "allUsers", role: "roles/run.invoker" })).toBe(true);
  });

  test("an endpoint override serves every target", async () => {
    const server = policyServer();
    await applyResource(iamPolicyMemberMapper, binding(), { base: "http://localhost:4588", project: "p1" }, server.http);
    expect(server.calls.every((c) => c.url.startsWith("http://localhost:4588/v2/"))).toBe(true);
  });

  test("delete removes only this member", async () => {
    const server = policyServer({ etag: "e1", bindings: [{ role: "roles/run.invoker", members: ["allUsers", "user:b"] }] });
    expect((await deleteResource(iamPolicyMemberMapper, binding(), ctx, server.http)).deleted).toBe(true);
    expect(server.policy().bindings).toEqual([{ role: "roles/run.invoker", members: ["user:b"] }]);
    expect((await deleteResource(iamPolicyMemberMapper, binding(), ctx, server.http)).deleted).toBe(false);
  });

  test("the reader answers present when the policy grants the member, absent when not", async () => {
    const server = policyServer({ bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] });
    const props = binding().spec as Record<string, unknown>;
    const body = await getResource({ project: "p1", http: server.http }, "IAMPolicyMember", "web-public", props);
    expect(body).toMatchObject({ member: "allUsers", role: "roles/run.invoker", resource: "projects/p1/locations/us-central1/services/web" });

    const empty = policyServer({ bindings: [] });
    await expect(getResource({ project: "p1", http: empty.http }, "IAMPolicyMember", "web-public", props)).rejects.toMatchObject({ status: 404 });
  });

  test("a binding on a target chant cannot reach is not accepted", () => {
    const fn = binding({ resourceRef: { kind: "CloudFunctionsFunction", name: "f" } });
    expect(MAPPERS.IAMPolicyMember.accepts!(fn, ctx)).toBe(false);
  });
});
