import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "alb-infra",
  lexicon: "aws",
  overview: "Build, publish, and deploy the shared ALB infrastructure via GitLab CI.",
  context: [
    file("examples/gitlab-aws-alb-infra/README.md"),
    file("examples/gitlab-aws-alb-infra/src/alb.ts"),
    file("examples/gitlab-aws-alb-infra/src/outputs.ts"),
    file("examples/gitlab-aws-alb-infra/src/pipeline.ts"),
  ],
  tasks: [
    task("Build: cd examples/gitlab-aws-alb-infra && npm run build", { done: true }),
    task("Create GitLab project: glab project create alb-infra --public (delete auto-created local dir if needed)", { done: true }),
    task("Set CI/CD variables: glab variable set AWS_DEFAULT_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY --masked on the alb-infra project", { done: true }),
    task("Standalone setup: copy to temp dir, swap package.standalone.json, npm install, verify npm run build works", { done: true }),
    task("Push to GitLab: init git, git add -f templates/ .gitlab-ci.yml package.json src/, commit, push via HTTPS (git remote add origin https://gitlab.com/<user>/alb-infra.git) — force-add, these are gitignored in monorepo", { done: true }),
    task("Verify pipeline: glab ci status — wait for deploy stage to succeed", { done: true }),
    task("Verify stack: aws cloudformation describe-stacks --stack-name shared-alb --query 'Stacks[0].StackStatus' returns CREATE_COMPLETE or UPDATE_COMPLETE", { done: true }),
    task("Verify outputs: aws cloudformation describe-stacks --stack-name shared-alb --query 'Stacks[0].Outputs' returns all 10 outputs", { done: true }),
  ],
});
