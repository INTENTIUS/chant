import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { dkrd001 } from "./no-latest-image";
import { dkrd002 } from "./unused-volume";
import { dkrd003 } from "./ssh-port-exposed";
import { dkrd010 } from "./apt-no-recommends";
import { dkrd011 } from "./prefer-copy";
import { dkrd012 } from "./no-root-user";
import { dkrd013 } from "./cache-busting-copy";
import { dkrd014 } from "./root-after-user";
import { dkrd015 } from "./repeated-cmd";
import { dkrd016 } from "./copy-from-stage";
import { dkrd017 } from "./unused-global-arg";
import { dkrd018 } from "./relative-workdir";
import { dkrd019 } from "./add-url-checksum";
import { dkrd020 } from "./apt-update-alone";

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

describe("DKRD012: final stage", () => {
  const run = (lines: string[]) => dkrd012.check(makeDockerfileCtx("Dockerfile.app", lines.join("\n") + "\n"));

  test("flags a final stage with no USER when only an earlier stage sets one", () => {
    const diags = run(["FROM node:20-alpine AS build", "USER node", "RUN npm ci", "FROM node:20-alpine", "CMD node index.js"]);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("final stage 2 has no USER");
  });

  test("flags a final stage that ends on USER root", () => {
    const diags = run(["FROM debian:12-slim", "USER app", "USER 0:0", "CMD x"]);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("ends on USER 0:0");
  });

  test("does not flag USER root for setup followed by a non-root USER", () => {
    expect(run(["FROM debian:12-slim", "USER root", "RUN apt-get update", "USER app", "CMD x"])).toHaveLength(0);
  });
});

const df = (lines: string[]) => makeDockerfileCtx("Dockerfile.app", lines.join("\n") + "\n");

describe("DKRD013: cache-busting copy", () => {
  test("flags COPY . . before npm ci", () => {
    const diags = dkrd013.check(df(["FROM node:20-alpine", "WORKDIR /app", "COPY . .", "RUN npm ci", "RUN npm run build"]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("COPY . . comes before RUN npm ci");
  });

  test("flags pip install -r and go mod download, across a continuation", () => {
    expect(dkrd013.check(df(["FROM python:3.12-slim", "COPY . /app", "RUN pip install --no-cache-dir \\", "    -r /app/requirements.txt"]))).toHaveLength(1);
    expect(dkrd013.check(df(["FROM golang:1.23", "COPY ./ ./", "RUN go mod download"]))).toHaveLength(1);
  });

  test("does not flag manifests copied first, COPY --from, or a package added by name", () => {
    expect(dkrd013.check(df(["FROM node:20-alpine", "COPY package*.json ./", "RUN npm ci", "COPY . .", "RUN npm run build"]))).toHaveLength(0);
    expect(dkrd013.check(df(["FROM node:20-alpine", "COPY --from=build /app .", "RUN npm ci"]))).toHaveLength(0);
    expect(dkrd013.check(df(["FROM node:20-alpine", "COPY . .", "RUN npm install -g serve"]))).toHaveLength(0);
  });
});

describe("DKRD014: root-only RUN after USER", () => {
  test("flags apt-get after a non-root USER", () => {
    const diags = dkrd014.check(df(["FROM debian:12-slim", "USER app", "RUN apt-get update && apt-get install -y curl"]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("runs as USER app");
  });

  test("does not flag root setup before USER, USER root, or sudo", () => {
    expect(dkrd014.check(df(["FROM debian:12-slim", "RUN useradd app", "USER app", "RUN whoami"]))).toHaveLength(0);
    expect(dkrd014.check(df(["FROM debian:12-slim", "USER app", "USER root", "RUN chown app /data", "USER app"]))).toHaveLength(0);
    expect(dkrd014.check(df(["FROM debian:12-slim", "USER app", "RUN sudo apt-get install -y curl"]))).toHaveLength(0);
  });

  test("a USER in one stage does not carry into the next", () => {
    expect(dkrd014.check(df(["FROM debian:12-slim AS a", "USER app", "FROM debian:12-slim", "RUN apt-get install -y curl"]))).toHaveLength(0);
  });
});

describe("DKRD015: repeated CMD or ENTRYPOINT", () => {
  test("flags two CMDs in a stage", () => {
    const diags = dkrd015.check(df(["FROM alpine:3.20", 'CMD ["a"]', "RUN true", 'CMD ["b"]']));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('2 CMD instructions; only the last (CMD ["b"])');
  });

  test("does not flag one CMD per stage", () => {
    expect(dkrd015.check(df(["FROM alpine:3.20 AS a", "CMD a", "FROM alpine:3.20", "ENTRYPOINT x", "CMD b"]))).toHaveLength(0);
  });
});

describe("DKRD016: COPY --from stage", () => {
  test("flags a stage that is only defined later", () => {
    const diags = dkrd016.check(df(["FROM alpine:3.20 AS final", "COPY --from=build /out /out", "FROM alpine:3.20 AS build"]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('names stage "build", which is not defined until later');
  });

  test("flags a name no stage has", () => {
    const diags = dkrd016.check(df(["FROM alpine:3.20 AS build", "FROM alpine:3.20", "COPY --from=biuld /out /out"]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('pulls an image called "biuld"');
  });

  test("does not flag earlier stages by name or index, or tagged images", () => {
    expect(dkrd016.check(df([
      "FROM alpine:3.20 AS build",
      "FROM alpine:3.20",
      "COPY --from=build /a /a",
      "COPY --from=0 /b /b",
      "COPY --from=nginx:1.27 /etc/nginx /etc/nginx",
    ]))).toHaveLength(0);
  });
});

describe("DKRD017: unused global ARG", () => {
  test("flags an ARG before FROM that nothing uses", () => {
    const diags = dkrd017.check(df(["ARG UNUSED=1", "FROM alpine:3.20"]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("ARG UNUSED");
  });

  test("does not flag an ARG used in FROM or declared again in a stage", () => {
    expect(dkrd017.check(df(["ARG NODE_VERSION=20", "FROM node:${NODE_VERSION}-alpine"]))).toHaveLength(0);
    expect(dkrd017.check(df(["ARG VERSION=1", "FROM alpine:3.20", "ARG VERSION", "RUN echo $VERSION"]))).toHaveLength(0);
  });
});

describe("DKRD018: relative WORKDIR", () => {
  test("flags a relative WORKDIR before any absolute one", () => {
    const diags = dkrd018.check(df(["FROM alpine:3.20", "WORKDIR app"]));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("WORKDIR app is relative");
  });

  test("does not flag a relative WORKDIR after an absolute one", () => {
    expect(dkrd018.check(df(["FROM alpine:3.20", "WORKDIR /src", "WORKDIR app"]))).toHaveLength(0);
  });
});

describe("DKRD019: ADD URL without checksum", () => {
  test("flags ADD of an https URL without --checksum", () => {
    expect(dkrd019.check(df(["FROM alpine:3.20", "ADD https://example.com/tool.tgz /tmp/"]))).toHaveLength(1);
  });

  test("does not flag --checksum or a local file", () => {
    expect(dkrd019.check(df(["FROM alpine:3.20", "ADD --checksum=sha256:abc https://example.com/tool.tgz /tmp/", "ADD local.tgz /tmp/"]))).toHaveLength(0);
  });
});

describe("DKRD020: apt-get update alone", () => {
  test("flags update in one RUN and install in a later one", () => {
    const diags = dkrd020.check(df(["FROM debian:12-slim", "RUN apt-get update", "RUN apt-get install -y --no-install-recommends curl"]));
    expect(diags).toHaveLength(1);
  });

  test("does not flag update and install in one RUN", () => {
    expect(dkrd020.check(df(["FROM debian:12-slim", "RUN apt-get update \\", "  && apt-get install -y --no-install-recommends curl"]))).toHaveLength(0);
  });
});
