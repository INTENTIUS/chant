import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { dkrd001 } from "./no-latest-image";
import { dkrd002 } from "./unused-volume";
import { dkrd003 } from "./ssh-port-exposed";
import { dkrd010 } from "./apt-no-recommends";
import { dkrd011 } from "./prefer-copy";
import { dkrd012 } from "./no-root-user";

// ── Helpers ─────────────────────────────────────────────────────────

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["docker", yaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["docker", yaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

function makeDockerfileCtx(dockerfileName: string, content: string): PostSynthContext {
  const result = {
    primary: "services:\n  app:\n    image: myapp:1.0\n",
    files: { [dockerfileName]: content },
  };
  return {
    outputs: new Map([["docker", result as unknown as string]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["docker", result as unknown as string]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

// ── DKRD001: no-latest-image ─────────────────────────────────────

describe("DKRD001: no-latest-image", () => {
  test("flags :latest image", () => {
    const yaml = `services:\n  api:\n    image: nginx:latest\n`;
    const diags = dkrd001.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("DKRD001");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("nginx:latest");
  });

  test("flags untagged image", () => {
    const yaml = `services:\n  api:\n    image: nginx\n`;
    const diags = dkrd001.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("DKRD001");
  });

  test("does not flag versioned image", () => {
    const yaml = `services:\n  api:\n    image: nginx:1.25-alpine\n`;
    const diags = dkrd001.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── DKRD002: unused-volume ──────────────────────────────────────

describe("DKRD002: unused-volume", () => {
  test("flags unused named volume", () => {
    const yaml = `services:\n  api:\n    image: myapp:1.0\n\nvolumes:\n  mydata:\n`;
    const diags = dkrd002.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("DKRD002");
    expect(diags[0].message).toContain("mydata");
  });

  test("does not flag volume that is mounted", () => {
    const yaml = `services:\n  api:\n    image: myapp:1.0\n    volumes:\n      - mydata:/data\n\nvolumes:\n  mydata:\n`;
    const diags = dkrd002.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("no volumes section returns empty", () => {
    const yaml = `services:\n  api:\n    image: myapp:1.0\n`;
    const diags = dkrd002.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── DKRD003: ssh-port-exposed ───────────────────────────────────

describe("DKRD003: ssh-port-exposed", () => {
  test("flags port 22 exposure", () => {
    const yaml = `services:\n  bastion:\n    image: ubuntu:22.04\n    ports:\n      - "22:22"\n`;
    const diags = dkrd003.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("DKRD003");
    expect(diags[0].severity).toBe("error");
  });

  test("does not flag other ports", () => {
    const yaml = `services:\n  api:\n    image: myapp:1.0\n    ports:\n      - "8080:8080"\n`;
    const diags = dkrd003.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag localhost-bound port 22", () => {
    const yaml = `services:\n  bastion:\n    image: ubuntu:22.04\n    ports:\n      - "127.0.0.1:22:22"\n`;
    const diags = dkrd003.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── DKRD010: apt-no-recommends ──────────────────────────────────

describe("DKRD010: apt-no-recommends", () => {
  test("flags apt-get install without --no-install-recommends", () => {
    const dockerfile = `FROM ubuntu:22.04\nRUN apt-get update && apt-get install -y curl\n`;
    const diags = dkrd010.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("DKRD010");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag with --no-install-recommends", () => {
    const dockerfile = `FROM ubuntu:22.04\nRUN apt-get update && apt-get install -y --no-install-recommends curl\n`;
    const diags = dkrd010.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-apt RUN", () => {
    const dockerfile = `FROM node:20-alpine\nRUN npm ci\n`;
    const diags = dkrd010.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags).toHaveLength(0);
  });
});

// ── DKRD011: prefer-copy ────────────────────────────────────────

describe("DKRD011: prefer-copy", () => {
  test("flags ADD with local file", () => {
    const dockerfile = `FROM ubuntu:22.04\nADD src/ /app/\n`;
    const diags = dkrd011.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("DKRD011");
  });

  test("does not flag ADD with URL", () => {
    const dockerfile = `FROM ubuntu:22.04\nADD https://example.com/file.tar.gz /tmp/\n`;
    const diags = dkrd011.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags).toHaveLength(0);
  });

  test("does not flag ADD with archive", () => {
    const dockerfile = `FROM ubuntu:22.04\nADD src.tar.gz /app/\n`;
    const diags = dkrd011.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags).toHaveLength(0);
  });
});

// ── DKRD012: no-root-user ────────────────────────────────────────

describe("DKRD012: no-root-user", () => {
  test("flags Dockerfile without USER instruction", () => {
    const dockerfile = `FROM node:20-alpine\nRUN npm ci\nCMD ["node", "index.js"]\n`;
    const diags = dkrd012.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("DKRD012");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag Dockerfile with USER instruction", () => {
    const dockerfile = `FROM node:20-alpine\nRUN npm ci\nUSER node\nCMD ["node", "index.js"]\n`;
    const diags = dkrd012.check(makeDockerfileCtx("Dockerfile.app", dockerfile));
    expect(diags).toHaveLength(0);
  });
});
