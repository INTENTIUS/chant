import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "alb-ui",
  lexicon: "aws",
  overview: "Build, publish, and deploy the UI Fargate service behind the shared ALB via GitLab CI.",
  depends: ["alb-infra"],
  context: [
    file("examples/gitlab-aws-alb-ui/README.md"),
    file("examples/gitlab-aws-alb-ui/src/service.ts"),
    file("examples/gitlab-aws-alb-ui/src/pipeline.ts"),
    file("examples/gitlab-aws-alb-ui/Dockerfile"),
  ],
  tasks: [
    task("Build: cd examples/gitlab-aws-alb-ui && npm run build", { done: true }),
    task("Create GitLab project: glab project create alb-ui --public (delete auto-created local dir if needed)", { done: true }),
    task("Set CI/CD variables: glab variable set AWS_DEFAULT_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY --masked, AWS_ACCOUNT_ID on the alb-ui project", { done: true }),
    task("Standalone setup: copy to temp dir, swap package.standalone.json, npm install, verify npm run build works", { done: true }),
    task("Push to GitLab: init git, git add -f templates/ .gitlab-ci.yml Dockerfile package.json src/, commit, push via HTTPS (git remote add origin https://gitlab.com/<user>/alb-ui.git) — force-add, these are gitignored in monorepo", { done: true }),
    task("Verify pipeline: glab ci status — wait for build and deploy stages to succeed", { done: true }),
    task("Verify stack: aws cloudformation describe-stacks --stack-name shared-alb-ui --query 'Stacks[0].StackStatus' returns CREATE_COMPLETE", { done: true }),
    task("Verify endpoint: curl http://<AlbDnsName>/ returns 200 with 'UI service healthy'", { done: true }),
  ],
});
