/**
 * Tier 1 marketplace action mappings — the 14 most-used GitHub Actions
 * marketplace actions, per the upstream skill's `references/marketplace-actions.md`.
 *
 * Each mapping returns:
 *   - scriptLines: appended to job.script
 *   - image: job-level image override (last write wins)
 *   - services: docker:dind etc.
 *   - cache / artifacts: native GitLab keywords
 *   - provenance: per-step records
 */

import type { ActionMapping, ActionMappedResult, ActionMapCtx } from "./registry";
import { getDefaultRegistry } from "./registry";

const prov = (
  ctx: ActionMapCtx,
  actionName: string,
  tier: 1 | 2 | 3,
  note: string,
  category: "literal" | "needs-review" | "skipped" | "action-map" = "action-map",
) => ({
  gitlabPath: `jobs.${ctx.logicalId}.script`,
  gitlabLogicalId: ctx.logicalId,
  sourceKey: `jobs.${ctx.jobName}.steps[${ctx.stepIndex}].uses`,
  sourceFile: ctx.sourceFile,
  category,
  rule: `ACT-${actionName.replace(/[\/-]/g, "-")}`,
  note,
  actionRef: actionName,
  mappingTier: tier,
});

function withVal<T>(o: Record<string, unknown> | undefined, key: string): T | undefined {
  if (!o) return undefined;
  return o[key] as T | undefined;
}

function getWith(step: Record<string, unknown>): Record<string, unknown> {
  return (step.with as Record<string, unknown>) ?? {};
}

// actions/checkout: GitLab clones automatically. Emit no script lines.
const actionsCheckout: ActionMapping = {
  actionName: "actions/checkout",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const variables: Record<string, unknown> = {};
    if (w["fetch-depth"] !== undefined) {
      variables.GIT_DEPTH = w["fetch-depth"];
    }
    if (w.submodules === true || w.submodules === "true" || w.submodules === "recursive") {
      variables.GIT_SUBMODULE_STRATEGY = w.submodules === "recursive" ? "recursive" : "normal";
    }
    return {
      scriptLines: [],
      variables: Object.keys(variables).length > 0 ? variables : undefined,
      provenance: [prov(ctx, "actions/checkout", 1, "Removed — GitLab clones the repository automatically", "skipped")],
    };
  },
};

// actions/setup-node: image: node:<version>
const actionsSetupNode: ActionMapping = {
  actionName: "actions/setup-node",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["node-version"] as string) ?? "22";
    const cache = w.cache as string | undefined;
    const cacheKey: Record<string, unknown> | undefined = cache === "npm"
      ? { key: { files: ["package-lock.json"] }, paths: [".npm/"] }
      : cache === "yarn"
        ? { key: { files: ["yarn.lock"] }, paths: [".yarn/cache/"] }
        : cache === "pnpm"
          ? { key: { files: ["pnpm-lock.yaml"] }, paths: [".pnpm-store/"] }
          : undefined;
    return {
      scriptLines: [],
      image: `node:${version}`,
      cache: cacheKey,
      provenance: [prov(ctx, "actions/setup-node", 1, `setup-node → image: node:${version}`)],
    };
  },
};

const actionsSetupPython: ActionMapping = {
  actionName: "actions/setup-python",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["python-version"] as string) ?? "3.12";
    const cache = w.cache as string | undefined;
    const cacheKey: Record<string, unknown> | undefined = cache === "pip"
      ? { paths: [".cache/pip/"] }
      : cache === "poetry"
        ? { paths: [".cache/pypoetry/"] }
        : undefined;
    return {
      scriptLines: [],
      image: `python:${version}`,
      cache: cacheKey,
      provenance: [prov(ctx, "actions/setup-python", 1, `setup-python → image: python:${version}`)],
    };
  },
};

const actionsSetupJava: ActionMapping = {
  actionName: "actions/setup-java",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["java-version"] as string) ?? "17";
    const cache = w.cache as string | undefined;
    const cacheKey: Record<string, unknown> | undefined = cache === "maven"
      ? { paths: [".m2/repository/"] }
      : cache === "gradle"
        ? { paths: [".gradle/"] }
        : undefined;
    return {
      scriptLines: [],
      image: `eclipse-temurin:${version}`,
      cache: cacheKey,
      provenance: [prov(ctx, "actions/setup-java", 1, `setup-java → image: eclipse-temurin:${version}`)],
    };
  },
};

const actionsSetupGo: ActionMapping = {
  actionName: "actions/setup-go",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["go-version"] as string) ?? "1.22";
    return {
      scriptLines: [],
      image: `golang:${version}`,
      cache: w.cache === true || w.cache === "true"
        ? { paths: [".cache/go-build/", "go/pkg/mod/"] }
        : undefined,
      provenance: [prov(ctx, "actions/setup-go", 1, `setup-go → image: golang:${version}`)],
    };
  },
};

const actionsSetupRuby: ActionMapping = {
  actionName: "actions/setup-ruby",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["ruby-version"] as string) ?? "3.3";
    return {
      scriptLines: [],
      image: `ruby:${version}`,
      cache: w["bundler-cache"] === true || w["bundler-cache"] === "true"
        ? { paths: ["vendor/bundle/"] }
        : undefined,
      provenance: [prov(ctx, "actions/setup-ruby", 1, `setup-ruby → image: ruby:${version}`)],
    };
  },
};

const actionsCache: ActionMapping = {
  actionName: "actions/cache",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const paths = (w.path as string)?.split("\n").map((p) => p.trim()).filter(Boolean) ?? [];
    const key = w.key as string | undefined;
    const cache: Record<string, unknown> = {};
    if (paths.length > 0) cache.paths = paths;
    if (key) cache.key = key;
    return {
      scriptLines: [],
      cache: Object.keys(cache).length > 0 ? cache : undefined,
      provenance: [prov(ctx, "actions/cache", 1, "actions/cache → native cache: keyword")],
    };
  },
};

const actionsUploadArtifact: ActionMapping = {
  actionName: "actions/upload-artifact",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const paths = (w.path as string)?.split("\n").map((p) => p.trim()).filter(Boolean) ?? [];
    const name = w.name as string | undefined;
    const retention = w["retention-days"] as number | string | undefined;
    const artifacts: Record<string, unknown> = {};
    if (paths.length > 0) artifacts.paths = paths;
    if (name) artifacts.name = name;
    if (retention !== undefined) artifacts.expire_in = `${retention} days`;
    return {
      scriptLines: [],
      artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
      provenance: [prov(ctx, "actions/upload-artifact", 1, "upload-artifact → native artifacts: keyword")],
    };
  },
};

const actionsDownloadArtifact: ActionMapping = {
  actionName: "actions/download-artifact",
  tier: 1,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: [],
      provenance: [prov(ctx, "actions/download-artifact", 1, "download-artifact removed — GitLab auto-passes artifacts via stages or needs:artifacts:")],
    };
  },
};

const dockerLoginAction: ActionMapping = {
  actionName: "docker/login-action",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const registry = (w.registry as string) ?? "";
    const userVar = withVal<string>(w, "username") ?? "$CI_REGISTRY_USER";
    const passVar = withVal<string>(w, "password") ?? "$CI_REGISTRY_PASSWORD";
    return {
      scriptLines: [`docker login -u ${userVar} -p ${passVar} ${registry}`.trim()],
      provenance: [prov(ctx, "docker/login-action", 1, "docker/login-action → inline docker login")],
    };
  },
};

const dockerBuildPushAction: ActionMapping = {
  actionName: "docker/build-push-action",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const context = (w.context as string) ?? ".";
    const file = (w.file as string) ?? "Dockerfile";
    const push = w.push === true || w.push === "true";
    const tags = (w.tags as string)?.split(/[\n,]/).map((t) => t.trim()).filter(Boolean) ?? [];
    const lines: string[] = [];
    const tagFlags = tags.map((t) => `-t ${t}`).join(" ");
    lines.push(`docker build -f ${file} ${tagFlags} ${context}`.trim());
    if (push) {
      for (const t of tags) lines.push(`docker push ${t}`);
    }
    return {
      scriptLines: lines,
      image: "docker:latest",
      services: [{ name: "docker:dind", alias: "docker", variables: { DOCKER_TLS_CERTDIR: "/certs" } }],
      provenance: [prov(ctx, "docker/build-push-action", 1, "docker/build-push-action → inline docker build/push + docker:dind service")],
    };
  },
};

const dockerSetupBuildxAction: ActionMapping = {
  actionName: "docker/setup-buildx-action",
  tier: 1,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: ["docker buildx create --use"],
      image: "docker:latest",
      services: [{ name: "docker:dind", alias: "docker", variables: { DOCKER_TLS_CERTDIR: "/certs" } }],
      provenance: [prov(ctx, "docker/setup-buildx-action", 1, "docker/setup-buildx-action → docker buildx create --use + docker:dind")],
    };
  },
};

const dockerSetupQemuAction: ActionMapping = {
  actionName: "docker/setup-qemu-action",
  tier: 1,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const platforms = (w.platforms as string) ?? "linux/amd64,linux/arm64";
    return {
      scriptLines: [`docker run --rm --privileged tonistiigi/binfmt --install ${platforms}`],
      provenance: [prov(ctx, "docker/setup-qemu-action", 1, "docker/setup-qemu-action → tonistiigi/binfmt")],
    };
  },
};

const actionsGithubScript: ActionMapping = {
  actionName: "actions/github-script",
  tier: 1,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: [
        "# TODO(migration): actions/github-script has no direct GitLab equivalent.",
        "# Replace with glab CLI or curl against the GitLab API.",
      ],
      provenance: [prov(
        ctx,
        "actions/github-script",
        1,
        "actions/github-script: use glab CLI or REST API",
        "needs-review",
      )],
    };
  },
};

const TIER_1_MAPPINGS: ActionMapping[] = [
  actionsCheckout,
  actionsSetupNode,
  actionsSetupPython,
  actionsSetupJava,
  actionsSetupGo,
  actionsSetupRuby,
  actionsCache,
  actionsUploadArtifact,
  actionsDownloadArtifact,
  dockerLoginAction,
  dockerBuildPushAction,
  dockerSetupBuildxAction,
  dockerSetupQemuAction,
  actionsGithubScript,
];

/**
 * Register all Tier 1 mappings into the given registry (or default).
 * Idempotent — call before `lookupAction` is first invoked.
 */
export function registerTier1(registry = getDefaultRegistry()): void {
  for (const m of TIER_1_MAPPINGS) {
    registry.register(m);
  }
}

export { TIER_1_MAPPINGS };
