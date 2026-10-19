/**
 * The demo on chant's runner (#4100): the stack's compose file runs `chant
 * ci serve` in place of forgejo-runner, and up's steps set up the runner key,
 * list it in the base's .chant/trust.json, write the secrets file and push a
 * base with no workflow. Fakes stand in for docker compose and the forge:
 * nothing here starts a container or opens a socket. pushBase pushes to a
 * bare repository in the temp directory.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCommandInProcess } from "../../../packages/core/src/cli/main.js";
import { readCiSecrets } from "../../../packages/core/src/workspace/ci-secrets.js";
import { runnerKeyListed } from "../../../packages/core/src/workspace/ci-runner-key.js";
import { loadRunnerKey } from "../../../packages/core/src/workspace/trust/dsse.js";
import { trustWrite } from "../../../packages/core/src/workspace/trust/trust-write.js";
import * as composeSrc from "./stack/src/compose.js";
import {
  BASE_EXCLUDE,
  RUNNER_KEY_SCRIPT,
  RUNNER_LOGIN,
  RUNNER_PRINCIPAL,
  RUNNER_SERVICE,
  RUNNER_STATE,
  STACK_DIR,
  pushBase,
  runnerSecretsOf,
  setupRunnerKey,
  writeRunnerSecrets,
  type StackConfig,
} from "./lib/stack.js";

const tmp = mkdtempSync(join(tmpdir(), "chant-fan-out-demo-stack-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const config = (name: string): StackConfig => ({ forgejoPort: 3390, flociPort: 4590, stateDir: join(tmp, name) });

const runnerPem = (): string => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const gitOut = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface ComposeService {
  image: string;
  command: string[];
  volumes: string[];
  environment: Record<string, string>;
  networks: Record<string, unknown>;
}

describe("the stack's compose.yaml", () => {
  let text = "";
  let doc: { services: Record<string, ComposeService>; volumes: Record<string, { name: string }> };

  beforeAll(async () => {
    const out = join(tmp, "compose.yaml");
    expect(await runCommandInProcess(["build", join(STACK_DIR, "src"), "--lexicon", "docker", "-o", out])).toBe(0);
    text = readFileSync(out, "utf8");
    doc = load(text) as typeof doc;
  }, 60_000);

  test("runs chant ci serve in the job image, with the demo's flags", () => {
    const runner = doc.services[RUNNER_SERVICE]!;
    expect(runner.image).toBe(composeSrc.JOB_IMAGE);
    expect(runner.command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(runner.command[2]).toContain(
      "chant ci serve --forge forgejo --repo chant-demo/fan-out-estate --env demo --branch main --author author --events-json " +
        "--report-url s3://chant-demo/fan-out-estate/reports --pr-build-command 'npm run build' --image chant-fan-out-demo-job:local " +
        "--secrets /run/chant/secrets.env --state /var/lib/chant-runner --once",
    );
    expect(runner.command[2]).toContain("install -m 600 /etc/chant-fan-out-demo/runner-secrets.env /run/chant/secrets.env");
    expect(runner.networks).toHaveProperty("demo");
    expect(runner.environment.GITHUB_SERVER_URL).toBe("http://forgejo:3000");
    expect(runner.environment.GITHUB_API_URL).toBe("http://forgejo:3000/api/v1");
    expect(runner.environment.GITHUB_TOKEN).toBe("${CHANT_FAN_OUT_DEMO_RUNNER_TOKEN:-}");
  });

  test("keeps the runner's state in its own volume and mounts no docker socket", () => {
    const runner = doc.services[RUNNER_SERVICE]!;
    expect(runner.volumes).toContain(`runnerState:${RUNNER_STATE}`);
    expect(doc.volumes.runnerState!.name).toBe("chant-fan-out-demo-runner-state");
    expect(text).not.toContain("docker.sock");
  });

  test("has no forgejo-runner, and Forgejo Actions is off", () => {
    expect(Object.keys(doc.services).sort()).toEqual(["chantRunner", "floci", "forgejo"]);
    expect(text).not.toContain("forgejo-runner");
    expect(text).not.toContain("forgejo/runner");
    expect(doc.services.forgejo!.environment.FORGEJO__actions__ENABLED).toBe("false");
  });

  test("names what lib/stack.ts names", () => {
    expect(composeSrc.RUNNER_STATE).toBe(RUNNER_STATE);
    expect(composeSrc.RUNNER_LOGIN).toBe(RUNNER_LOGIN);
    expect(RUNNER_KEY_SCRIPT).toContain(`--state ${composeSrc.RUNNER_STATE}`);
  });
});

describe("up's runner steps", () => {
  test("write the secrets file with mode 0600, and ci serve reads it", () => {
    const c = config("secrets");
    const path = writeRunnerSecrets(c);
    expect(path).toBe(runnerSecretsOf(c));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readCiSecrets(path).values).toEqual({
      AWS_ENDPOINT_URL: "http://floci:4566",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_REGION: "us-east-1",
    });
    // A file left loose by hand is made 0600 again.
    writeFileSync(path, "", { mode: 0o644 });
    execFileSync("chmod", ["644", path]);
    writeRunnerSecrets(c);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("set up the key with chant ci serve --setup-key in the runner's container", async () => {
    const calls: string[][] = [];
    const pub = loadRunnerKey(runnerPem()).publicKey;
    const key = await setupRunnerKey(async (args) => {
      calls.push(args);
      return { stdout: `npm notice something\n${pub}\n` };
    });
    expect(key).toBe(pub);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 5)).toEqual(["run", "--rm", "--no-deps", "-T", RUNNER_SERVICE]);
    expect(calls[0]!.slice(5, 7)).toEqual(["sh", "-c"]);
    expect(calls[0]![7]).toContain(`chant ci serve --setup-key --state ${RUNNER_STATE} --branch main`);
    await expect(setupRunnerKey(async () => ({ stdout: "no key\n" }))).rejects.toThrow(/no ssh-ed25519 key/);
  });

  test("push a base that lists the runner key in .chant/trust.json and has no workflow file", async () => {
    const c = config("base");
    const remote = join(tmp, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const pem = runnerPem();
    const pub = loadRunnerKey(pem).publicKey;
    const chantCalls: string[][] = [];
    // The real trust write, in process, as `chant workspace trust runner add` runs it.
    const chant = async (args: string[], cwd: string): Promise<{ stdout: string }> => {
      chantCalls.push(args);
      expect(args.slice(0, 4)).toEqual(["workspace", "trust", "runner", "add"]);
      const doc = trustWrite({ cwd, action: "runner add", name: args[4]!, key: args[args.indexOf("--key") + 1]! });
      return { stdout: JSON.stringify(doc) };
    };

    const sha = await pushBase(c, { login: "chant-admin", token: "t0ken" }, pub, { chant, remote });

    expect(chantCalls).toEqual([["workspace", "trust", "runner", "add", RUNNER_PRINCIPAL, "--key", pub]]);
    expect(gitOut(remote, ["rev-parse", "main"])).toBe(sha);
    expect(gitOut(remote, ["log", "-1", "--format=%s", "main"])).toContain("[skip ci]");
    const files = gitOut(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    expect(files).toContain(".chant/trust.json");
    expect(files).toContain(".chant/allowed_signers");
    expect(files).toContain("chant.config.ts");
    expect(files.filter((f) => f.startsWith(".forgejo/"))).toEqual([]);
    // The example's own .chant is left out, and the base writes its own two files there.
    for (const left of BASE_EXCLUDE) if (left !== ".chant") expect(files.filter((f) => f === left || f.startsWith(`${left}/`))).toEqual([]);
    expect(files.filter((f) => f.startsWith(".chant/")).sort()).toEqual([".chant/allowed_signers", ".chant/trust.json"]);

    const trust = JSON.parse(gitOut(remote, ["show", "main:.chant/trust.json"])) as { runners: Array<{ principal: string; class: string; key: string }>; roles: Record<string, string[]> };
    expect(trust.runners).toEqual([{ principal: RUNNER_PRINCIPAL, class: "runner", key: pub }]);
    expect(trust.roles.runner).toEqual([RUNNER_PRINCIPAL]);
    // What ci serve checks before its first poll: the base lists the key with the runner role.
    const tree = join(c.stateDir, "base-tree");
    expect(runnerKeyListed(tree, sha, pem)).toEqual({ ok: true, principal: RUNNER_PRINCIPAL });
  }, 60_000);
});
