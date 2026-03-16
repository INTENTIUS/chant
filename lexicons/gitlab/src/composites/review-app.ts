import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, Image, Environment, Rule } from "../generated";
import { CI } from "../variables";

export interface ReviewAppProps {
  /** Base name for the jobs (e.g. "review" → review-deploy, review-stop in YAML). */
  name: string;
  /** Deploy script command(s). */
  deployScript: string | string[];
  /** Stop script command(s). Default: echo "Stopping review app..." */
  stopScript?: string | string[];
  /** Environment URL pattern. Default: "https://$CI_ENVIRONMENT_SLUG.example.com" */
  urlPattern?: string;
  /** Auto-stop timer. Default: "1 week" */
  autoStopIn?: string;
  /** Override image for both jobs. */
  image?: InstanceType<typeof Image>;
  /** Job stage. Default: "deploy" */
  stage?: string;
  /** Per-member defaults for customizing the deploy and stop jobs. */
  defaults?: {
    deploy?: Partial<ConstructorParameters<typeof Job>[0]>;
    stop?: Partial<ConstructorParameters<typeof Job>[0]>;
  };
}

export const ReviewApp = Composite<ReviewAppProps>((props) => {
  const {
    name,
    deployScript,
    stopScript = 'echo "Stopping review app..."',
    urlPattern = `https://${CI.EnvironmentSlug}.example.com`,
    autoStopIn = "1 week",
    image,
    stage = "deploy",
    defaults: defs,
  } = props;

  const stopJobName = `${name}-stop`;

  const deployScriptArr = Array.isArray(deployScript) ? deployScript : [deployScript];
  const stopScriptArr = Array.isArray(stopScript) ? stopScript : [stopScript];

  const deploy = new Job(mergeDefaults({
    stage,
    ...(image ? { image } : {}),
    environment: new Environment({
      name: `review/${CI.CommitRefSlug}`,
      url: urlPattern,
      auto_stop_in: autoStopIn,
      on_stop: stopJobName,
    }),
    rules: [new Rule({ if: CI.MergeRequestIid })],
    script: deployScriptArr,
  }, defs?.deploy));

  const stop = new Job(mergeDefaults({
    stage,
    ...(image ? { image } : {}),
    environment: new Environment({
      name: `review/${CI.CommitRefSlug}`,
      action: "stop",
    }),
    rules: [new Rule({ if: CI.MergeRequestIid, when: "manual" })],
    script: stopScriptArr,
  }, defs?.stop));

  return { deploy, stop };
}, "ReviewApp");
