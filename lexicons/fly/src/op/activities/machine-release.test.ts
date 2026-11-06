import { describe, test, expect } from "vitest";
import {
  RELEASE_METADATA_KEYS,
  MachineReleaseError,
  checksPending,
  declaresChecks,
  flyMachineChecks,
  flyMachineExec,
  flyMachineRelease,
  flyMachineRestart,
  flyMachineRestore,
  flyMachineStop,
  flyMachineVerify,
  readMachineRelease,
  releaseTarget,
  withReleaseMetadata,
} from "./machine-release";
import { createMachinesFake } from "./machines-fake";
import { flyApply, type FlyPlan } from "./fly-apply";

const ENDPOINT = "http://flaps.test";
const NO_WAIT = { intervalMs: 0, deadlineMs: 2_000 };

const PLAN: FlyPlan = {
  shop: { endpoint: "/v1/apps", method: "POST", body: { app_name: "shop", org_slug: "personal" } },
  web: {
    endpoint: "/v1/apps/shop/machines",
    method: "POST",
    body: { name: "web", config: { image: "shop:1", env: { PORT: "8080" }, metadata: { "managed-by": "chant" } } },
  },
};

describe("release metadata (pure)", () => {
  test("withReleaseMetadata stamps the release and keeps other metadata", () => {
    const config = withReleaseMetadata({ image: "x", metadata: { "managed-by": "chant", [RELEASE_METADATA_KEYS.release]: "old" } }, {
      digest: "sha256:a",
      gitSha: "abc1234",
    });
    expect(config.metadata).toEqual({
      "managed-by": "chant",
      [RELEASE_METADATA_KEYS.digest]: "sha256:a",
      [RELEASE_METADATA_KEYS.gitSha]: "abc1234",
    });
    expect(readMachineRelease(config.metadata)).toEqual({ digest: "sha256:a", gitSha: "abc1234" });
  });

  test("readMachineRelease names no release without a digest", () => {
    expect(readMachineRelease({ "managed-by": "chant" })).toBeUndefined();
    expect(readMachineRelease(undefined)).toBeUndefined();
  });

  test("releaseTarget picks the plan's one Machine, or the one named", () => {
    expect(releaseTarget(PLAN)).toMatchObject({ app: "shop", entity: "web", name: "web" });
    expect(() => releaseTarget(PLAN, "worker")).toThrow(/no Machine named "worker"/);
    const two: FlyPlan = { ...PLAN, worker: { endpoint: "/v1/apps/shop/machines", method: "POST", body: { name: "worker", config: {} } } };
    expect(() => releaseTarget(two)).toThrow(/declares 2 Machines/);
    expect(releaseTarget(two, "worker").name).toBe("worker");
  });
});

describe("Machines activities against the fake", () => {
  test("a first release creates the App and Machine with the release in its metadata", async () => {
    const fake = createMachinesFake();
    const r = await flyMachineRelease(
      { plan: PLAN, endpoint: ENDPOINT, release: { digest: "sha256:one", gitSha: "1111111" }, image: "shop@sha256:img1", env: { MODE: "prod" }, wait: NO_WAIT },
      undefined,
      fake.http,
    );
    expect(r).toMatchObject({ app: "shop", action: "created", previous: null, release: { digest: "sha256:one", gitSha: "1111111" } });
    const m = fake.machine("shop", "web")!;
    expect(m.config.image).toBe("shop@sha256:img1");
    expect(m.config.env).toEqual({ PORT: "8080", MODE: "prod" });
    expect(readMachineRelease(m.config.metadata)).toEqual({ digest: "sha256:one", gitSha: "1111111" });
    expect(m.config.metadata?.["managed-by"]).toBe("chant");
  });

  test("a second release records the one it replaced, and re-running it keeps that", async () => {
    const fake = createMachinesFake();
    const args = { plan: PLAN, endpoint: ENDPOINT, wait: NO_WAIT };
    await flyMachineRelease({ ...args, release: { digest: "sha256:one" } }, undefined, fake.http);
    const two = await flyMachineRelease({ ...args, release: { digest: "sha256:two" } }, undefined, fake.http);
    expect(two.action).toBe("updated");
    expect(two.release.previousDigest).toBe("sha256:one");
    expect(two.previous?.release?.digest).toBe("sha256:one");
    expect(readMachineRelease(two.previous?.config.metadata)?.digest).toBe("sha256:one");
    const again = await flyMachineRelease({ ...args, release: { digest: "sha256:two" } }, undefined, fake.http);
    expect(again.action).toBe("noop");
    expect(again.release.previousDigest).toBe("sha256:one");
  });

  test("exec runs a command in the Machine and fails on a non-zero exit", async () => {
    const fake = createMachinesFake({ exec: (_app, _m, cmd) => (cmd.join(" ").includes("bad") ? { exit_code: 3, stderr: "no table" } : { exit_code: 0, stdout: "ok" }) });
    await flyMachineRelease({ plan: PLAN, endpoint: ENDPOINT, release: { digest: "sha256:one" }, wait: NO_WAIT }, undefined, fake.http);
    const ok = await flyMachineExec({ app: "shop", machine: "web", command: "migrate 001", endpoint: ENDPOINT }, undefined, fake.http);
    expect(ok).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(fake.execs[0].command).toEqual(["sh", "-c", "migrate 001"]);
    await expect(flyMachineExec({ app: "shop", machine: "web", command: ["bad"], endpoint: ENDPOINT }, undefined, fake.http)).rejects.toThrow(
      /exited 3.*no table/,
    );
  });

  test("stop and restart settle the Machine under a lease", async () => {
    const fake = createMachinesFake();
    await flyMachineRelease({ plan: PLAN, endpoint: ENDPOINT, release: { digest: "sha256:one" }, wait: NO_WAIT }, undefined, fake.http);
    await flyMachineStop({ app: "shop", machine: "web", endpoint: ENDPOINT, wait: NO_WAIT }, undefined, fake.http);
    expect(fake.machine("shop", "web")!.state).toBe("stopped");
    await flyMachineRestart({ app: "shop", machine: "web", endpoint: ENDPOINT, wait: NO_WAIT }, undefined, fake.http);
    expect(fake.machine("shop", "web")!.state).toBe("started");
    expect(fake.calls.filter((c) => c.endsWith("/lease"))).toHaveLength(4);
  });

  test("verify: started with the release, and the health endpoint reports it", async () => {
    const fake = createMachinesFake();
    await flyMachineRelease(
      { plan: PLAN, endpoint: ENDPOINT, release: { digest: "sha256:one", gitSha: "1111111" }, wait: NO_WAIT },
      undefined,
      fake.http,
    );
    const health = (revision: string) => (async () => new Response(JSON.stringify({ status: "healthy", revision }))) as unknown as typeof fetch;
    const base = { app: "shop", machine: "web", endpoint: ENDPOINT, intervalMs: 1, timeoutMs: 20 };
    await expect(flyMachineVerify({ ...base, digest: "sha256:one", url: "https://shop.test" }, undefined, fake.http, health("1111111"))).resolves.toMatchObject({
      release: { digest: "sha256:one" },
    });
    await expect(flyMachineVerify({ ...base, digest: "sha256:two" }, undefined, fake.http)).rejects.toThrow(/serves sha256:one, expected sha256:two/);
    await expect(flyMachineVerify({ ...base, digest: "sha256:one", url: "https://shop.test" }, undefined, fake.http, health("2222222"))).rejects.toThrow(
      /reports 2222222/,
    );
    await flyMachineStop({ app: "shop", machine: "web", endpoint: ENDPOINT, wait: NO_WAIT }, undefined, fake.http);
    await expect(flyMachineVerify({ ...base, digest: "sha256:one" }, undefined, fake.http)).rejects.toThrow(/is stopped/);
  });

  test("restore puts a recorded Machine config back", async () => {
    const fake = createMachinesFake();
    const args = { plan: PLAN, endpoint: ENDPOINT, wait: NO_WAIT };
    const one = await flyMachineRelease({ ...args, release: { digest: "sha256:one" }, image: "shop:1" }, undefined, fake.http);
    await flyMachineRelease({ ...args, release: { digest: "sha256:two" }, image: "shop:2" }, undefined, fake.http);
    expect(fake.machine("shop", "web")!.config.image).toBe("shop:2");
    const restored = await flyMachineRestore({ app: "shop", machine: "web", config: one.config, endpoint: ENDPOINT, wait: NO_WAIT }, undefined, fake.http);
    expect(restored.release?.digest).toBe("sha256:one");
    expect(fake.machine("shop", "web")!.config).toEqual(one.config);
  });
});

/** #4719: Fly checks on the Machines a release rolls. */
describe("Fly checks", () => {
  const CHECKED = { services: [{ internal_port: 8080, checks: [{ type: "http", port: 8080, path: "/platform.json" }] }] };
  const TWO: FlyPlan = {
    shop: PLAN.shop,
    web: { endpoint: "/v1/apps/shop/machines", method: "POST", body: { name: "web", config: { image: "shop:1", ...CHECKED } } },
    web2: { endpoint: "/v1/apps/shop/machines", method: "POST", body: { name: "web2", config: { image: "shop:1", ...CHECKED } } },
  };

  test("declaresChecks reads top-level and service checks", () => {
    expect(declaresChecks({ image: "x" })).toBe(false);
    expect(declaresChecks({ checks: {} })).toBe(false);
    expect(declaresChecks({ checks: { alive: { type: "tcp", port: 8080 } } })).toBe(true);
    expect(declaresChecks(CHECKED)).toBe(true);
    expect(declaresChecks({ services: [{ internal_port: 8080 }] })).toBe(false);
  });

  test("checksPending names each check that is not passing", () => {
    expect(checksPending({ config: {} })).toBeUndefined();
    expect(checksPending({ config: CHECKED })).toBe("no check has reported yet");
    expect(checksPending({ config: CHECKED, checks: [{ name: "a", status: "passing" }] })).toBeUndefined();
    expect(
      checksPending({ config: CHECKED, checks: [{ name: "a", status: "passing" }, { name: "b", status: "critical", output: " 503 Service Unavailable\n" }] }),
    ).toBe("check b is critical (503 Service Unavailable)");
  });

  test("flyApply's afterMachine runs after each Machine settles, and a throw stops the apply there", async () => {
    const fake = createMachinesFake();
    const seen: string[] = [];
    await expect(
      flyApply(
        {
          plan: TWO,
          endpoint: ENDPOINT,
          wait: NO_WAIT,
          afterMachine: async (m) => {
            seen.push(`${m.name}:${m.action}`);
            if (m.name === "web") throw new Error("stop here");
          },
        },
        undefined,
        fake.http,
      ),
    ).rejects.toThrow("stop here");
    expect(seen).toEqual(["web:created"]);
    expect(fake.machine("shop", "web2")).toBeUndefined();
  });

  test("flyMachineChecks waits for every check to pass, and names the Machine and the check when one does not", async () => {
    let reads = 0;
    const fake = createMachinesFake({
      checks: (_app, m) => (m.name === "web" ? [{ name: "servicecheck-00-http-8080", status: ++reads > 3 ? "passing" : "critical", output: "503" }] : undefined),
    });
    await flyApply({ plan: TWO, endpoint: ENDPOINT, wait: NO_WAIT }, undefined, fake.http);
    await expect(flyMachineChecks({ app: "shop", machine: "web", endpoint: ENDPOINT, intervalMs: 1, timeoutMs: 1_000 }, undefined, fake.http)).resolves.toBeDefined();
    expect(reads).toBeGreaterThan(3);
    // web2 declares checks that never report.
    await expect(flyMachineChecks({ app: "shop", machine: "web2", endpoint: ENDPOINT, intervalMs: 1, timeoutMs: 20 }, undefined, fake.http)).rejects.toThrow(
      /machine shop\/web2 \(m[0-9a-f]+\) did not pass its Fly checks within 20ms: no check has reported yet/,
    );
  });

  test("flyMachineVerify with checks needs them passing; without, it reads only state and release", async () => {
    let status: "passing" | "critical" = "critical";
    const fake = createMachinesFake({ checks: () => [{ name: "alive", status }] });
    await flyMachineRelease({ plan: TWO, machine: "web", endpoint: ENDPOINT, release: { digest: "sha256:one" }, wait: NO_WAIT }, undefined, fake.http);
    const base = { app: "shop", machine: "web", endpoint: ENDPOINT, digest: "sha256:one", intervalMs: 1, timeoutMs: 20 };
    await expect(flyMachineVerify(base, undefined, fake.http)).resolves.toBeDefined();
    await expect(flyMachineVerify({ ...base, checks: true }, undefined, fake.http)).rejects.toThrow(/verify shop\/web: machine shop\/web \(m[0-9a-f]+\): check alive is critical/);
    status = "passing";
    await expect(flyMachineVerify({ ...base, checks: true }, undefined, fake.http)).resolves.toBeDefined();
  });

  test("flyMachineRelease with checks: a Machine that does not pass stops the roll and names what it applied", async () => {
    const fake = createMachinesFake({ checks: (_app, m) => [{ name: "alive", status: m.config.image === "shop:bad" ? "critical" : "passing" }] });
    const args = { plan: TWO, machine: "web", endpoint: ENDPOINT, wait: NO_WAIT, checks: { intervalMs: 1, timeoutMs: 20 } };
    const first = await flyMachineRelease({ ...args, release: { digest: "sha256:one" } }, undefined, fake.http);
    expect(first.applied.map((m) => [m.name, m.action, m.serving])).toEqual([
      ["web", "created", true],
      ["web2", "created", false],
    ]);
    const err = await flyMachineRelease({ ...args, release: { digest: "sha256:two" }, image: "shop:bad", images: { web2: "shop:bad" } }, undefined, fake.http).catch((e) => e);
    expect(err).toBeInstanceOf(MachineReleaseError);
    expect(err.message).toMatch(/machine shop\/web .* did not pass its Fly checks within 20ms: check alive is critical/);
    // The roll stopped at web: web2 was never updated.
    expect((err as MachineReleaseError).applied.map((m) => [m.name, m.action])).toEqual([["web", "updated"]]);
    expect((err as MachineReleaseError).applied[0].previous?.image).toBe("shop:1");
    expect(fake.machine("shop", "web2")!.config.image).toBe("shop:1");
  });

  test("restore with checks waits for the restored Machine's checks", async () => {
    const fake = createMachinesFake({ checks: (_app, m) => [{ name: "alive", status: m.config.image === "shop:1" ? "passing" : "critical" }] });
    const args = { plan: TWO, machine: "web", endpoint: ENDPOINT, wait: NO_WAIT };
    const one = await flyMachineRelease({ ...args, release: { digest: "sha256:one" } }, undefined, fake.http);
    await flyMachineRelease({ ...args, release: { digest: "sha256:two" }, image: "shop:2" }, undefined, fake.http);
    const restore = { app: "shop", machine: "web", endpoint: ENDPOINT, wait: NO_WAIT, checks: { intervalMs: 1, timeoutMs: 20 } };
    await expect(flyMachineRestore({ ...restore, config: one.config }, undefined, fake.http)).resolves.toMatchObject({ release: { digest: "sha256:one" } });
    await expect(flyMachineRestore({ ...restore, config: { ...one.config, image: "shop:2" } }, undefined, fake.http)).rejects.toThrow(/check alive is critical/);
  });
});
