/**
 * Credential policy (chant #1074's managed-cluster half).
 *
 * The exec-plugin caching case runs a real subprocess — a two-line node script
 * that prints an `ExecCredential` and appends a line to a temp file so the test
 * can count invocations. It talks to no cluster and reads no ambient
 * kubeconfig; the API server is still the injected request layer.
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExecCredentialAllowed,
  credentialPathOf,
  DEFAULT_EXEC_ALLOWLIST,
  execCommandName,
  execConfigOf,
} from "./credentials";
import { ExecCredentialNotAllowedError } from "./errors";
import { createK8sClient } from "./client";
import { apiResourceList, fakeKubeconfig, fakeRequestLayer, statusBody } from "./testing";

describe("exec credential allowlist", () => {
  test("a bare command, an absolute path and a Windows executable all reduce to the same name", () => {
    expect(execCommandName("aws")).toBe("aws");
    expect(execCommandName("/usr/local/bin/aws")).toBe("aws");
    expect(execCommandName("C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe")).toBe("aws");
  });

  test("the managed-cluster plugins pass; anything else is refused by name", () => {
    for (const command of ["aws", "/opt/homebrew/bin/gke-gcloud-auth-plugin", "kubelogin"]) {
      expect(() => assertExecCredentialAllowed({ name: "u", exec: { command } })).not.toThrow();
    }
    expect(() => assertExecCredentialAllowed({ name: "u", exec: { command: "curl" } })).toThrow(
      ExecCredentialNotAllowedError,
    );
  });

  test("the refusal names the command and how to allow it", () => {
    const err = (() => {
      try {
        assertExecCredentialAllowed({ name: "u", exec: { command: "harvest" } });
      } catch (e) {
        return e as Error;
      }
    })()!;
    expect(err.message).toContain('"harvest"');
    expect(err.message).toContain("k8s.execCredentialPlugins");
  });

  test("an exec stanza hidden under authProvider is gated too", () => {
    const user = { name: "u", authProvider: { name: "exec", config: { exec: { command: "harvest" } } } };
    expect(execConfigOf(user)?.command).toBe("harvest");
    expect(() => assertExecCredentialAllowed(user)).toThrow(ExecCredentialNotAllowedError);
  });

  test("a user with no exec plugin is never gated", () => {
    expect(() => assertExecCredentialAllowed({ name: "u", token: "t" })).not.toThrow();
    expect(() => assertExecCredentialAllowed(undefined)).not.toThrow();
  });

  test("an explicit allowlist replaces the default", () => {
    expect(() => assertExecCredentialAllowed({ name: "u", exec: { command: "aws" } }, ["kubelogin"])).toThrow();
    expect(() => assertExecCredentialAllowed({ name: "u", exec: { command: "custom" } }, ["custom"])).not.toThrow();
  });

  test("the default allowlist covers EKS, AKS and GKE", () => {
    expect(DEFAULT_EXEC_ALLOWLIST).toContain("aws");
    expect(DEFAULT_EXEC_ALLOWLIST).toContain("kubelogin");
    expect(DEFAULT_EXEC_ALLOWLIST).toContain("gke-gcloud-auth-plugin");
  });
});

describe("credential provenance", () => {
  test.each([
    [{ name: "u", exec: { command: "aws" } }, "exec-plugin"],
    [{ name: "u", authProvider: { name: "oidc" } }, "auth-provider"],
    [{ name: "u", token: "t" }, "token"],
    [{ name: "u", certData: "c" }, "client-certificate"],
    [{ name: "u", username: "admin", password: "p" }, "basic-auth"],
    [{ name: "u" }, "none"],
  ])("%o is %s", (user, expected) => {
    expect(credentialPathOf(user).credential).toBe(expected);
  });
});

describe("exec credential caching", () => {
  test("one plugin invocation serves an entire multi-entity observation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-execauth-"));
    const counterFile = join(dir, "invocations.log");
    const scriptFile = join(dir, "plugin.mjs");
    writeFileSync(
      scriptFile,
      [
        `import { appendFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(counterFile)}, "x\\n");`,
        `process.stdout.write(JSON.stringify({`,
        `  apiVersion: "client.authentication.k8s.io/v1",`,
        `  kind: "ExecCredential",`,
        `  status: { token: "exec-issued-token", expirationTimestamp: "2099-01-01T00:00:00Z" },`,
        `}));`,
      ].join("\n"),
    );

    const deployments = apiResourceList("apps/v1", [{ name: "deployments", kind: "Deployment" }]);
    const layer = fakeRequestLayer((req) => {
      if (req.path === "/apis/apps/v1") return { body: deployments };
      if (req.path.startsWith("/apis/apps/v1/namespaces/prod/deployments/")) {
        return { body: { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x", uid: "u" } } };
      }
      return { status: 404, body: statusBody(404, "NotFound", "no") };
    });

    const client = await createK8sClient({
      // The "plugin" is this node binary running the script above — a real
      // subprocess on the real ExecAuth path, with nothing to install.
      kubeconfig: fakeKubeconfig({ exec: { command: process.execPath, args: [scriptFile] } }),
      execAllowlist: [process.execPath],
      requestLayer: layer,
    });

    await client.concurrently(
      Array.from({ length: 20 }, (_, i) => i),
      (i) => client.read({ apiVersion: "apps/v1", kind: "Deployment", name: `web-${i}`, namespace: "prod" }),
    );

    const invocations = existsSync(counterFile) ? readFileSync(counterFile, "utf8").trim().split("\n").length : 0;
    rmSync(dir, { recursive: true, force: true });

    // 21 requests (discovery + 20 reads) authorized by one plugin run.
    expect(layer.requests.length).toBe(21);
    expect(invocations).toBe(1);
    for (const req of layer.requests) {
      expect(req.headers.Authorization).toBe("Bearer exec-issued-token");
    }
  }, 30_000);
});
