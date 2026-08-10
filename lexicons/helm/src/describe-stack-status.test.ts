import { describe, test, expect } from "vitest";
import { describeStackStatus } from "./describe-stack-status";

const list = (entries: unknown) => async () => ({ stdout: JSON.stringify(entries) });

describe("helm describeStackStatus (#1495 piece 4)", () => {
  test("a deployed release: present and healthy, with Helm's native status", async () => {
    const obs = await describeStackStatus(
      { environment: "local", stack: "api" },
      list([{ name: "api", namespace: "prod", status: "deployed", revision: "3" }]),
    );
    expect(obs).toEqual({ stack: "api", present: true, status: "deployed", healthy: true });
  });

  test("a failed release: present, unhealthy, status carried verbatim", async () => {
    const obs = await describeStackStatus(
      { environment: "local", stack: "api" },
      list([{ name: "api", namespace: "prod", status: "failed" }]),
    );
    expect(obs).toEqual({ stack: "api", present: true, status: "failed", healthy: false });
  });

  test("pending-upgrade is present but not healthy — deployed is the one success state", async () => {
    const obs = await describeStackStatus(
      { environment: "local", stack: "api" },
      list([{ name: "api", status: "pending-upgrade" }]),
    );
    expect(obs).toMatchObject({ present: true, status: "pending-upgrade", healthy: false });
  });

  test("release not in the list: absent — the pre-first-install state", async () => {
    const obs = await describeStackStatus(
      { environment: "local", stack: "api" },
      list([{ name: "other", status: "deployed" }]),
    );
    expect(obs).toEqual({ stack: "api", present: false });
  });

  test("a namespace-qualified unit only matches its own namespace", async () => {
    const entries = [
      { name: "api", namespace: "staging", status: "failed" },
      { name: "api", namespace: "prod", status: "deployed" },
    ];
    const prod = await describeStackStatus({ environment: "local", stack: "prod/api" }, list(entries));
    expect(prod).toMatchObject({ present: true, status: "deployed", healthy: true });

    const gone = await describeStackStatus({ environment: "local", stack: "dev/api" }, list(entries));
    expect(gone).toEqual({ stack: "dev/api", present: false });
  });

  test("helm missing or cluster unreachable: null — indeterminate, never a confident absence", async () => {
    const obs = await describeStackStatus({ environment: "local", stack: "api" }, async () => {
      throw new Error("helm: command not found");
    });
    expect(obs).toBeNull();
  });

  test("unparseable or non-array output: null", async () => {
    expect(await describeStackStatus({ environment: "local", stack: "api" }, async () => ({ stdout: "WARNING: ..." }))).toBeNull();
    expect(await describeStackStatus({ environment: "local", stack: "api" }, async () => ({ stdout: '{"not":"an array"}' }))).toBeNull();
  });
});
