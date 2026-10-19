/**
 * The image chant's runner runs in, `chant-fan-out-demo-job:local`: the
 * chant-runner service runs `chant ci serve` in it, and each job runs in
 * process there, in a worktree of the runner's clone. The driver builds it
 * into the local daemon from Dockerfile.jobImage, and applies the base in it
 * too. The example's generated workflow names the same image (`container:`)
 * for anyone who runs the estate on Forgejo Actions instead.
 *
 * It carries node and git, the chant CLI and the aws lexicon at one pinned
 * release, and a pinned AWS CLI v2, which cfn-deploy and the `--report-url`
 * upload run. chant and the lexicon live in /opt/chant, linked as
 * /node_modules, so a checkout anywhere in the container resolves the
 * templates' imports of @intentius/chant-lexicon-aws by walking up to the
 * root, and /usr/local/bin/chant is the CLI.
 *
 * CHANT_VERSION is the release the demo host runs (#4085 section 7, default
 * 6). It has to be a release with `chant ci serve`, its secrets file and its
 * runner key (#4094 to #4099), so it is the release after 0.124.30; local
 * runs may pass a newer one as a build arg. The AWS CLI release and its
 * sha256 per arch are the ones the earlier driver's job image checked its
 * download against.
 */
import { Dockerfile } from "@intentius/chant-lexicon-docker";

export const CHANT_VERSION = "0.124.31";
export const AWS_CLI_VERSION = "2.37.9";
const AWS_CLI_SHA256 = {
  arm64: "e7d2cca3622af4765871fe9ce7eeed03acd09dca10a99ebc46e92f79d78765c0",
  amd64: "6b3a6a3d7bb3997928f0bdf7b866914224abf242c2e54e1dcebbe84bee64f356",
};
const NODE_IMAGE = "node:24-slim";

export const jobImage = new Dockerfile({
  stages: [
    {
      from: NODE_IMAGE,
      as: "awscli",
      steps: [
        { arg: "TARGETARCH" },
        { arg: `AWS_CLI_VERSION=${AWS_CLI_VERSION}` },
        { run: "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*" },
        {
          run: [
            "set -e;",
            'case "$TARGETARCH" in',
            `arm64) a=aarch64; sum=${AWS_CLI_SHA256.arm64} ;;`,
            `*) a=x86_64; sum=${AWS_CLI_SHA256.amd64} ;;`,
            "esac;",
            'curl -fsSLo /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-$a-${AWS_CLI_VERSION}.zip";',
            'echo "$sum  /tmp/awscliv2.zip" | sha256sum -c -;',
            "unzip -q /tmp/awscliv2.zip -d /tmp;",
            "/tmp/aws/install --install-dir /usr/local/aws-cli --bin-dir /tmp/aws-bin",
          ].join(" "),
        },
      ],
    },
    {
      from: NODE_IMAGE,
      steps: [
        { arg: `CHANT_VERSION=${CHANT_VERSION}` },
        { run: "apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*" },
        { copy: "--from=awscli /usr/local/aws-cli /usr/local/aws-cli" },
        {
          run: [
            "ln -sf /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws",
            'npm install --prefix /opt/chant --omit=dev --no-audit --no-fund "@intentius/chant@${CHANT_VERSION}" "@intentius/chant-lexicon-aws@${CHANT_VERSION}"',
            "npm cache clean --force",
            "ln -s /opt/chant/node_modules /node_modules",
            "ln -sf /opt/chant/node_modules/.bin/chant /usr/local/bin/chant",
            "chant --version",
            "aws --version",
            "git --version",
          ].join(" && "),
        },
        { label: 'org.opencontainers.image.title="chant-fan-out-demo-job"' },
        { label: 'org.opencontainers.image.description="node, git, the chant CLI and its aws lexicon, and AWS CLI v2, for the chant fan-out demo\'s runner and its jobs"' },
      ],
    },
  ],
});
