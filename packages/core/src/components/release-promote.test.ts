/**
 * A promote under a release reads the target's recorded templates and checks
 * their digests (#4026, ws-104 question 5).
 */

import { describe, test, expect } from "vitest";
import { contentDigest } from "../content-digest";
import { makeRelease } from "../lifecycle/release-store";
import type { DriverComponent } from "./driver";
import { pinReleaseTemplates, targetFor, RELEASE_TEMPLATES_DIR } from "./release-promote";

const prodTemplate = `{"env":"prod"}\n`;
const release = makeRelease({
  member: null,
  commit: "c".repeat(40),
  artifactDigests: [],
  targets: [
    { env: "staging", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"staging"}\n`) }], params: [] },
    { env: "prod", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(prodTemplate) }], params: [] },
  ],
});
const prod = release.targets.find((t) => t.env === "prod")!;

const api: DriverComponent = {
  name: "api",
  deploy: [
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar" }] },
    { phase: "Apply", steps: [{ kind: "gate", gate: "prod" }, { kind: "cfn-deploy", template: "dist/api.template.json", imageRef: "@Publish.digest" }] },
  ],
};

const store = (content: string | null) => async (digest: string) => (digest === prod.templates[0].digest ? content : null);

describe("pinReleaseTemplates", () => {
  test("points the deploy at the target's recorded template, by digest", async () => {
    const pinned = await pinReleaseTemplates([api], release, prod, store(prodTemplate));
    if ("errors" in pinned) throw new Error(pinned.errors.join("\n"));
    const path = `${RELEASE_TEMPLATES_DIR}/${prod.templates[0].digest.replace(/:/g, "_")}/api.template.json`;
    expect(pinned.files).toEqual([{ path, content: prodTemplate }]);
    expect(pinned.components[0].deploy[1].steps[1]).toEqual({ kind: "cfn-deploy", template: path, imageRef: "@Publish.digest" });
    // The publish step and the gate are left as they were.
    expect(pinned.components[0].deploy[0]).toEqual(api.deploy[0]);
    expect(pinned.components[0].deploy[1].steps[0]).toEqual({ kind: "gate", gate: "prod" });
  });

  test("refuses a template whose digest differs from the target's", async () => {
    const pinned = await pinReleaseTemplates([api], release, prod, store(`{"env":"prod","edited":true}\n`));
    expect("errors" in pinned && pinned.errors.join("\n")).toMatch(
      new RegExp(`template "dist/api.template.json" hashes to sha256:[0-9a-f]{64}, but the release's target for "prod" records ${prod.templates[0].digest}; refusing to deploy it`),
    );
  });

  test("refuses a template the target does not record, and one whose bytes are missing", async () => {
    const other: DriverComponent = { name: "api", deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/new.template.json" }] }] };
    const missing = await pinReleaseTemplates([other], release, prod, store(prodTemplate));
    expect("errors" in missing && missing.errors[0]).toMatch(/reads template "dist\/new.template.json", which release .* does not record for "prod"/);
    const absent = await pinReleaseTemplates([api], release, prod, store(null));
    expect("errors" in absent && absent.errors[0]).toMatch(/are not on the chant\/lifecycle branch/);
  });

  test("targetFor names the environments a release was compiled for", () => {
    expect(targetFor(release, "prod")).toEqual({ target: prod });
    expect(targetFor(release, "qa")).toEqual({ error: expect.stringMatching(/has no target for "qa"; it was compiled for prod, staging/) });
  });
});
