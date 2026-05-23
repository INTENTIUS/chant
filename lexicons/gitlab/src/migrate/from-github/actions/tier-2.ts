/**
 * Tier 2 marketplace action mappings — 14 common actions from the
 * upstream skill's `references/marketplace-actions.md`.
 */

import type { ActionMapping, ActionMappedResult, ActionMapCtx } from "./registry";
import { getDefaultRegistry } from "./registry";

const prov = (
  ctx: ActionMapCtx,
  actionName: string,
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
  mappingTier: 2 as const,
});

const getWith = (s: Record<string, unknown>): Record<string, unknown> =>
  (s.with as Record<string, unknown>) ?? {};

const actionsSetupDotnet: ActionMapping = {
  actionName: "actions/setup-dotnet",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["dotnet-version"] as string) ?? "8.0";
    return {
      scriptLines: [],
      image: `mcr.microsoft.com/dotnet/sdk:${version}`,
      cache: { paths: [".nuget/packages/"] },
      provenance: [prov(ctx, "actions/setup-dotnet", `setup-dotnet → image: mcr.microsoft.com/dotnet/sdk:${version}`)],
    };
  },
};

const shivammathurSetupPhp: ActionMapping = {
  actionName: "shivammathur/setup-php",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["php-version"] as string) ?? "8.3";
    const extensions = (w.extensions as string) ?? "";
    const lines = ["apt-get update"];
    if (extensions) lines.push(`docker-php-ext-install ${extensions.split(",").map((s) => s.trim()).join(" ")}`);
    return {
      scriptLines: [],
      image: `php:${version}`,
      beforeScript: lines,
      provenance: [prov(ctx, "shivammathur/setup-php", `setup-php → image: php:${version} + before_script extensions`)],
    };
  },
};

const awsConfigureCredentials: ActionMapping = {
  actionName: "aws-actions/configure-aws-credentials",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const region = (w["aws-region"] as string) ?? "us-east-1";
    return {
      scriptLines: [],
      variables: {
        AWS_DEFAULT_REGION: region,
      },
      provenance: [prov(
        ctx,
        "aws-actions/configure-aws-credentials",
        "Configure AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY as masked CI/CD variables, or use GitLab OIDC to AWS",
        "needs-review",
      )],
    };
  },
};

const googleAuthAction: ActionMapping = {
  actionName: "google-github-actions/auth",
  tier: 2,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: [
        "echo $GCP_SA_KEY | base64 -d > /tmp/gcp-key.json",
        "gcloud auth activate-service-account --key-file=/tmp/gcp-key.json",
      ],
      variables: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp-key.json" },
      provenance: [prov(
        ctx,
        "google-github-actions/auth",
        "Set GCP_SA_KEY as masked CI/CD variable (base64-encoded), or use GitLab OIDC to GCP",
        "needs-review",
      )],
    };
  },
};

const azureLogin: ActionMapping = {
  actionName: "azure/login",
  tier: 2,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: ["az login --service-principal -u $AZURE_CLIENT_ID -p $AZURE_CLIENT_SECRET --tenant $AZURE_TENANT_ID"],
      provenance: [prov(
        ctx,
        "azure/login",
        "Set AZURE_CLIENT_ID/SECRET/TENANT_ID as masked CI/CD variables, or use GitLab OIDC to Azure",
        "needs-review",
      )],
    };
  },
};

const hashicorpSetupTerraform: ActionMapping = {
  actionName: "hashicorp/setup-terraform",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w.terraform_version as string) ?? "1.6";
    return {
      scriptLines: [],
      image: `hashicorp/terraform:${version}`,
      provenance: [prov(ctx, "hashicorp/setup-terraform", `setup-terraform → image: hashicorp/terraform:${version} (or use GitLab Terraform template)`)],
    };
  },
};

const codecovAction: ActionMapping = {
  actionName: "codecov/codecov-action",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const file = (w.files as string) ?? (w.file as string) ?? "coverage.xml";
    return {
      scriptLines: [
        "pip install codecov-cli",
        `codecovcli upload-process --file ${file} --token $CODECOV_TOKEN`,
      ],
      provenance: [prov(ctx, "codecov/codecov-action", "codecov-action → codecov-cli; set CODECOV_TOKEN as masked variable")],
    };
  },
};

const softpropsGhRelease: ActionMapping = {
  actionName: "softprops/action-gh-release",
  tier: 2,
  translate(_step, ctx): ActionMappedResult {
    return {
      scriptLines: ["glab release create $CI_COMMIT_TAG"],
      provenance: [prov(
        ctx,
        "softprops/action-gh-release",
        "softprops/action-gh-release → glab release create (for GitLab) or curl GitHub API",
        "needs-review",
      )],
    };
  },
};

const peterEvansCreatePr: ActionMapping = {
  actionName: "peter-evans/create-pull-request",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const title = (w.title as string) ?? "Automated update";
    return {
      scriptLines: [
        "git config user.email \"ci@example.com\"",
        "git config user.name \"CI Bot\"",
        "git add .",
        `git commit -m "${title}"`,
        `glab mr create --title "${title}"`,
      ],
      provenance: [prov(
        ctx,
        "peter-evans/create-pull-request",
        "create-pull-request → glab mr create",
        "needs-review",
      )],
    };
  },
};

const jamesIvesPagesDeploy: ActionMapping = {
  actionName: "JamesIves/github-pages-deploy-action",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const folder = (w.folder as string) ?? "build";
    return {
      scriptLines: [
        "mkdir -p public",
        `cp -r ${folder}/* public/`,
      ],
      artifacts: { paths: ["public"] },
      provenance: [prov(
        ctx,
        "JamesIves/github-pages-deploy-action",
        "pages-deploy → GitLab Pages requires job name 'pages' and artifacts in public/. May need a separate `pages:` job.",
        "needs-review",
      )],
    };
  },
};

const pnpmActionSetup: ActionMapping = {
  actionName: "pnpm/action-setup",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w.version as string) ?? "9";
    return {
      scriptLines: [`npm install -g pnpm@${version}`],
      cache: { paths: [".pnpm-store/"] },
      provenance: [prov(ctx, "pnpm/action-setup", `pnpm/action-setup → npm install -g pnpm@${version}`)],
    };
  },
};

const ovenSetupBun: ActionMapping = {
  actionName: "oven-sh/setup-bun",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["bun-version"] as string) ?? "latest";
    return {
      scriptLines: [],
      image: `oven/bun:${version}`,
      cache: { paths: [".bun/install/cache/"] },
      provenance: [prov(ctx, "oven-sh/setup-bun", `setup-bun → image: oven/bun:${version}`)],
    };
  },
};

const gradleBuildAction: ActionMapping = {
  actionName: "gradle/gradle-build-action",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const version = (w["gradle-version"] as string) ?? "8";
    return {
      scriptLines: [],
      image: `gradle:${version}`,
      cache: { paths: [".gradle/"] },
      provenance: [prov(ctx, "gradle/gradle-build-action", `gradle-build-action → image: gradle:${version}`)],
    };
  },
};

const cypressAction: ActionMapping = {
  actionName: "cypress-io/github-action",
  tier: 2,
  translate(step, ctx): ActionMappedResult {
    const w = getWith(step);
    const browser = (w.browser as string) ?? "chrome";
    const start = w.start as string | undefined;
    const lines: string[] = ["npm install"];
    if (start) lines.push(`${start} &`);
    lines.push(`npx cypress run --browser ${browser}`);
    return {
      scriptLines: lines,
      image: "cypress/browsers:latest",
      provenance: [prov(ctx, "cypress-io/github-action", `cypress-io → cypress/browsers image + npx cypress run`)],
    };
  },
};

const TIER_2_MAPPINGS: ActionMapping[] = [
  actionsSetupDotnet,
  shivammathurSetupPhp,
  awsConfigureCredentials,
  googleAuthAction,
  azureLogin,
  hashicorpSetupTerraform,
  codecovAction,
  softpropsGhRelease,
  peterEvansCreatePr,
  jamesIvesPagesDeploy,
  pnpmActionSetup,
  ovenSetupBun,
  gradleBuildAction,
  cypressAction,
];

export function registerTier2(registry = getDefaultRegistry()): void {
  for (const m of TIER_2_MAPPINGS) {
    registry.register(m);
  }
}

export { TIER_2_MAPPINGS };
