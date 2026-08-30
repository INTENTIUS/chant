/**
 * aws stack-level env teardown (#1222) — unit tests over fake Query-API
 * transports, in the style of aws-apply.test.ts: no network, the fakes answer
 * DescribeStacks/DeleteStack by parsing the form body.
 */
import { describe, test, expect } from "vitest";
import { teardownOwned, executeTeardown, resolveTeardownStacks, STACK_TYPE } from "./teardown";
import type { AwsReadHttp } from "./api/read-client";
import type { AwsHttp } from "./op/activities/aws-apply";
import type { OwnershipMarker } from "@intentius/chant/ownership";

const MARKER: OwnershipMarker = { stack: "shop", env: "dev" };

const MISSING =
  "<ErrorResponse><Error><Code>ValidationError</Code><Message>Stack with id x does not exist</Message></Error></ErrorResponse>";

/** A DescribeStacks response for one stack carrying the given tags. */
function stackXml(name: string, tags: Record<string, string>, status = "CREATE_COMPLETE"): string {
  const members = Object.entries(tags)
    .map(([k, v]) => `<member><Key>${k}</Key><Value>${v}</Value></member>`)
    .join("");
  return (
    `<DescribeStacksResponse><DescribeStacksResult><Stacks><member>` +
    `<StackId>arn:aws:cloudformation:us-east-1:0:stack/${name}/uuid</StackId>` +
    `<StackName>${name}</StackName><StackStatus>${status}</StackStatus>` +
    `<Tags>${members}</Tags>` +
    `</member></Stacks></DescribeStacksResult></DescribeStacksResponse>`
  );
}

const OWNED_TAGS = { "chant:managed-by": "chant", "chant:stack": "shop", "chant:env": "dev" };
const FOREIGN_ENV_TAGS = { "chant:managed-by": "chant", "chant:stack": "shop", "chant:env": "prod" };

/**
 * A fake read transport: answers DescribeStacks per stack name from `stacks`;
 * names not present answer "does not exist".
 */
function fakeRead(stacks: Record<string, string>): AwsReadHttp {
  return async (_url, init) => {
    const form = new URLSearchParams(init.body);
    expect(form.get("Action")).toBe("DescribeStacks");
    const name = form.get("StackName") ?? "";
    const xml = stacks[name];
    return xml ? { status: 200, text: xml } : { status: 400, text: MISSING };
  };
}

describe("resolveTeardownStacks — stacks[] else the env-named default (#932)", () => {
  test("declared stacks win", () => {
    expect(
      resolveTeardownStacks({
        environment: "dev",
        marker: MARKER,
        stacks: [{ name: "net" }, { name: "app", region: "eu-west-1" }],
      }),
    ).toEqual([{ name: "net" }, { name: "app", region: "eu-west-1" }]);
  });

  test("explicit stack option, else the stack named after the environment", () => {
    expect(resolveTeardownStacks({ environment: "dev", marker: MARKER, stack: "s1" })).toEqual([{ name: "s1" }]);
    expect(resolveTeardownStacks({ environment: "dev", marker: MARKER })).toEqual([{ name: "dev" }]);
  });
});

describe("teardownOwned — marker-verified stack enumeration", () => {
  test("a stack whose own tags carry the requested identity is a candidate", async () => {
    const result = await teardownOwned(
      { environment: "dev", marker: MARKER },
      { read: { http: fakeRead({ dev: stackXml("dev", OWNED_TAGS) }) } },
    );
    expect(result.candidates).toEqual([
      {
        name: "dev",
        type: STACK_TYPE,
        physicalId: "arn:aws:cloudformation:us-east-1:0:stack/dev/uuid",
        marker: { stack: "shop", env: "dev" },
      },
    ]);
    expect(result.holes).toBeUndefined();
  });

  test("an untagged stack is a loud unverified-ownership hole, never a candidate", async () => {
    const result = await teardownOwned(
      { environment: "dev", marker: MARKER },
      { read: { http: fakeRead({ dev: stackXml("dev", {}) }) } },
    );
    expect(result.candidates).toEqual([]);
    expect(result.holes).toHaveLength(1);
    expect(result.holes![0]).toMatchObject({ name: "dev", type: STACK_TYPE, reason: "filtered" });
    expect(result.holes![0].detail).toMatch(/unverified-ownership/);
  });

  test("a stack verifiably carrying ANOTHER identity is out of scope — no candidate, no hole", async () => {
    const result = await teardownOwned(
      { environment: "dev", marker: MARKER },
      { read: { http: fakeRead({ dev: stackXml("dev", FOREIGN_ENV_TAGS) }) } },
    );
    expect(result.candidates).toEqual([]);
    expect(result.holes).toBeUndefined();
  });

  test("an absent stack is knowledge: nothing to tear down, no hole", async () => {
    const result = await teardownOwned(
      { environment: "dev", marker: MARKER },
      { read: { http: fakeRead({}) } },
    );
    expect(result.candidates).toEqual([]);
    expect(result.holes).toBeUndefined();
  });

  test("a failed DescribeStacks is a hole (#1089), never absence", async () => {
    const http: AwsReadHttp = async () => ({ status: 500, text: "boom" });
    const result = await teardownOwned({ environment: "dev", marker: MARKER }, { read: { http } });
    expect(result.candidates).toEqual([]);
    expect(result.holes).toHaveLength(1);
    expect(result.holes![0]).toMatchObject({ name: "dev", type: STACK_TYPE, reason: "read-failed" });
  });

  test("multi-stack: every declared stack is checked, only verified ones are candidates", async () => {
    const result = await teardownOwned(
      {
        environment: "dev",
        marker: MARKER,
        stacks: [{ name: "net" }, { name: "app" }, { name: "gone" }],
      },
      {
        read: {
          http: fakeRead({
            net: stackXml("net", OWNED_TAGS),
            app: stackXml("app", FOREIGN_ENV_TAGS),
          }),
        },
      },
    );
    expect(result.candidates.map((c) => c.name)).toEqual(["net"]);
    expect(result.holes).toBeUndefined();
  });
});

describe("executeTeardown — re-verify, then DeleteStack to DELETE_COMPLETE", () => {
  const CANDIDATE = { name: "dev", type: STACK_TYPE, marker: { stack: "shop", env: "dev" } };

  /** A stateful fake pair: reads see the stack until DeleteStack lands. */
  function fakeTarget(initialTags: Record<string, string> | undefined) {
    const deletes: string[] = [];
    let present = initialTags !== undefined;
    const read: AwsReadHttp = async (_url, init) => {
      const form = new URLSearchParams(init.body);
      const name = form.get("StackName") ?? "";
      if (!present) return { status: 400, text: MISSING };
      return { status: 200, text: stackXml(name, initialTags ?? {}) };
    };
    const apply: AwsHttp = async (_url, form) => {
      if (form.Action === "DeleteStack") {
        deletes.push(form.StackName ?? "");
        present = false;
        return { status: 200, text: "<DeleteStackResponse/>" };
      }
      if (form.Action === "DescribeStacks") {
        return present
          ? { status: 200, text: stackXml(form.StackName ?? "", initialTags ?? {}) }
          : { status: 400, text: MISSING };
      }
      throw new Error(`unexpected action ${form.Action}`);
    };
    return { read, apply, deletes };
  }

  test("a marker-verified stack is deleted and polled gone", async () => {
    const target = fakeTarget(OWNED_TAGS);
    const result = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [CANDIDATE] },
      { read: { http: target.read }, applyHttp: target.apply, timeoutMs: 1000, intervalMs: 1 },
    );
    expect(result.outcomes).toEqual([{ name: "dev", type: STACK_TYPE, outcome: "deleted" }]);
    expect(target.deletes).toEqual(["dev"]);
  });

  test("an identity that no longer matches is not-prunable — DeleteStack is never sent", async () => {
    const target = fakeTarget(FOREIGN_ENV_TAGS);
    const result = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [CANDIDATE] },
      { read: { http: target.read }, applyHttp: target.apply, timeoutMs: 1000, intervalMs: 1 },
    );
    expect(result.outcomes[0]).toMatchObject({ name: "dev", outcome: "not-prunable" });
    expect(result.outcomes[0].detail).toMatch(/unverified-ownership/);
    expect(target.deletes).toEqual([]);
  });

  test("an untagged stack at execution time is not-prunable too", async () => {
    const target = fakeTarget({});
    const result = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [CANDIDATE] },
      { read: { http: target.read }, applyHttp: target.apply, timeoutMs: 1000, intervalMs: 1 },
    );
    expect(result.outcomes[0]).toMatchObject({ name: "dev", outcome: "not-prunable" });
    expect(target.deletes).toEqual([]);
  });

  test("an already-absent stack is deleted (teardown is idempotent)", async () => {
    const target = fakeTarget(undefined);
    const result = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [CANDIDATE] },
      { read: { http: target.read }, applyHttp: target.apply, timeoutMs: 1000, intervalMs: 1 },
    );
    expect(result.outcomes).toEqual([
      { name: "dev", type: STACK_TYPE, outcome: "deleted", detail: "already absent" },
    ]);
    expect(target.deletes).toEqual([]);
  });

  test("a failed DeleteStack is a failed outcome, never silence", async () => {
    const target = fakeTarget(OWNED_TAGS);
    const apply: AwsHttp = async (_url, form) => {
      if (form.Action === "DeleteStack") return { status: 500, text: "<ErrorResponse><Error><Message>throttled</Message></Error></ErrorResponse>" };
      return target.apply(_url, form);
    };
    const result = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [CANDIDATE] },
      { read: { http: target.read }, applyHttp: apply, timeoutMs: 1000, intervalMs: 1 },
    );
    expect(result.outcomes[0]).toMatchObject({ name: "dev", outcome: "failed" });
    expect(result.outcomes[0].detail).toMatch(/throttled/);
  });

  test("a candidate's region comes from the declared stacks", async () => {
    // The URL is only regional when no ambient endpoint override is set.
    const saved = {
      all: process.env.AWS_ENDPOINT_URL,
      cfn: process.env.AWS_ENDPOINT_URL_CLOUDFORMATION,
    };
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_ENDPOINT_URL_CLOUDFORMATION;
    const urls: string[] = [];
    const target = fakeTarget(OWNED_TAGS);
    const apply: AwsHttp = async (url, form) => {
      urls.push(url);
      return target.apply(url, form);
    };
    const read: AwsReadHttp = async (url, init) => {
      urls.push(url);
      return target.read(url, init);
    };
    await executeTeardown(
      {
        environment: "dev",
        marker: MARKER,
        candidates: [{ ...CANDIDATE, name: "app" }],
        stacks: [{ name: "app", region: "eu-west-1" }],
      },
      { read: { http: read }, applyHttp: apply, timeoutMs: 1000, intervalMs: 1 },
    );
    if (saved.all !== undefined) process.env.AWS_ENDPOINT_URL = saved.all;
    if (saved.cfn !== undefined) process.env.AWS_ENDPOINT_URL_CLOUDFORMATION = saved.cfn;
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes("eu-west-1"))).toBe(true);
  });
});
