import { Composite, withDefaults } from "@intentius/chant";
import { Job, Default, Image, Cache, Artifacts } from "../generated";
import { CI } from "../variables";

export interface NodePipelineProps {
  /** Node.js version. Default: "22" */
  nodeVersion?: string;
  /** Package manager. Default: "npm" */
  packageManager?: "npm" | "pnpm" | "bun";
  /** Build script name (runs via package manager). Default: "build" */
  buildScript?: string;
  /** Test script name. Default: "test" */
  testScript?: string;
  /** Artifact paths from build. Default: ["dist/"] */
  buildArtifactPaths?: string[];
  /** Artifact expiry. Default: "1 hour" */
  artifactExpiry?: string;
  /** Override auto-detected install command */
  installCommand?: string;
}

const cacheConfig = {
  npm: {
    paths: [".npm/"],
    keyFile: "package-lock.json",
    envVars: { npm_config_cache: `${CI.ProjectDir}/.npm/` },
    installCmd: "npm ci",
    runPrefix: "npm run",
  },
  pnpm: {
    paths: [".pnpm-store/"],
    keyFile: "pnpm-lock.yaml",
    envVars: {},
    installCmd: "pnpm install --frozen-lockfile",
    runPrefix: "pnpm run",
  },
  bun: {
    paths: [".bun/install/cache"],
    keyFile: "bun.lock",
    envVars: {},
    installCmd: "bun install --frozen-lockfile",
    runPrefix: "bun run",
  },
} as const;

export const NodePipeline = Composite<NodePipelineProps>((props) => {
  const {
    nodeVersion = "22",
    packageManager = "npm",
    buildScript = "build",
    testScript = "test",
    buildArtifactPaths = ["dist/"],
    artifactExpiry = "1 hour",
    installCommand,
  } = props;

  const pm = cacheConfig[packageManager];
  const install = installCommand ?? pm.installCmd;
  const run = pm.runPrefix;

  const nodeImage = new Image({ name: `node:${nodeVersion}-alpine` });

  const cache = new Cache({
    key: { files: [pm.keyFile] },
    paths: pm.paths as unknown as string[],
    policy: "pull-push",
  });

  const variables = Object.keys(pm.envVars).length > 0 ? pm.envVars : undefined;

  const defaults = new Default({
    image: nodeImage,
    cache: [cache],
    ...(variables ? {} : {}),
  });

  const build = new Job({
    stage: "build",
    script: [install, `${run} ${buildScript}`],
    artifacts: new Artifacts({
      paths: buildArtifactPaths,
      expire_in: artifactExpiry,
    }),
    ...(variables ? { variables } : {}),
  });

  const test = new Job({
    stage: "test",
    script: [install, `${run} ${testScript}`],
    artifacts: new Artifacts({
      reports: { junit: "junit.xml" },
      when: "always",
    }),
    ...(variables ? { variables } : {}),
  });

  return { defaults, build, test };
}, "NodePipeline");

/** NodePipeline preset for Bun projects. */
export const BunPipeline = withDefaults(NodePipeline, { packageManager: "bun" as const });

/** NodePipeline preset for pnpm projects. */
export const PnpmPipeline = withDefaults(NodePipeline, { packageManager: "pnpm" as const });
