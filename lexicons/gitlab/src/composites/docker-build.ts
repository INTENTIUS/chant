import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, Image, Service, Rule } from "../generated";
import { CI } from "../variables";

export interface DockerBuildProps {
  /** Job stage. Default: "build" */
  stage?: string;
  /** Image tag. Default: $CI_COMMIT_REF_SLUG */
  tag?: string;
  /** Dockerfile path. Default: "Dockerfile" */
  dockerfile?: string;
  /** Build context. Default: "." */
  context?: string;
  /** Container registry. Default: $CI_REGISTRY */
  registry?: string;
  /** Full image name. Default: $CI_REGISTRY_IMAGE */
  image?: string;
  /** Tag as :latest on default branch. Default: true */
  tagLatest?: boolean;
  /** Extra docker build --build-arg flags */
  buildArgs?: Record<string, string>;
  /** Job rules. Default: none (always runs) */
  rules?: InstanceType<typeof Rule>[];
  /** Docker version. Default: "27" */
  dockerVersion?: string;
  /** Per-member defaults for customizing the build job. */
  defaults?: {
    build?: Partial<ConstructorParameters<typeof Job>[0]>;
  };
}

export const DockerBuild = Composite<DockerBuildProps>((props) => {
  const {
    stage = "build",
    tag = CI.CommitRefSlug,
    dockerfile = "Dockerfile",
    context = ".",
    registry = CI.Registry,
    image = CI.RegistryImage,
    tagLatest = true,
    buildArgs,
    rules,
    dockerVersion = "27",
    defaults: defs,
  } = props;

  const buildArgFlags = buildArgs
    ? Object.entries(buildArgs)
        .map(([k, v]) => `--build-arg ${k}=${v}`)
        .join(" ")
    : "";

  const buildCmd = [
    "docker build",
    buildArgFlags,
    `-t ${image}:${tag}`,
    `-f ${dockerfile}`,
    context,
  ]
    .filter(Boolean)
    .join(" ");

  const script: string[] = [buildCmd, `docker push ${image}:${tag}`];

  if (tagLatest) {
    script.push(
      `if [ "${CI.CommitBranch}" = "${CI.DefaultBranch}" ]; then docker tag ${image}:${tag} ${image}:latest && docker push ${image}:latest; fi`,
    );
  }

  const build = new Job(mergeDefaults({
    stage,
    image: new Image({ name: `docker:${dockerVersion}-cli` }),
    services: [new Service({ name: `docker:${dockerVersion}-dind`, alias: "docker" })],
    variables: {
      DOCKER_TLS_CERTDIR: "/certs",
    },
    before_script: [
      `docker login -u ${CI.RegistryUser} -p ${CI.RegistryPassword} ${registry}`,
    ],
    script,
    ...(rules ? { rules } : {}),
  }, defs?.build));

  return { build };
}, "DockerBuild");
