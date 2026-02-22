import { describe, test, expect } from "bun:test";
import { expandComposite, isCompositeInstance } from "@intentius/chant";
import { DockerBuild } from "./docker-build";
import { NodePipeline, BunPipeline, PnpmPipeline } from "./node-pipeline";
import { PythonPipeline } from "./python-pipeline";
import { ReviewApp } from "./review-app";

// ---------------------------------------------------------------------------
// DockerBuild
// ---------------------------------------------------------------------------
describe("DockerBuild", () => {
  test("returns a build member", () => {
    const instance = DockerBuild({});
    expect(instance.build).toBeDefined();
    expect(Object.keys(instance.members)).toEqual(["build"]);
  });

  test("is a CompositeInstance", () => {
    expect(isCompositeInstance(DockerBuild({}))).toBe(true);
  });

  test("build job has docker image and dind service", () => {
    const instance = DockerBuild({});
    const props = (instance.build as any).props;
    expect(props.image).toBeDefined();
    const imgProps = (props.image as any).props;
    expect(imgProps.name).toBe("docker:27-cli");
    expect(props.services).toHaveLength(1);
    const svcProps = (props.services[0] as any).props;
    expect(svcProps.name).toBe("docker:27-dind");
    expect(svcProps.alias).toBe("docker");
  });

  test("sets TLS cert dir variable", () => {
    const instance = DockerBuild({});
    const props = (instance.build as any).props;
    expect(props.variables.DOCKER_TLS_CERTDIR).toBe("/certs");
  });

  test("default stage is build", () => {
    const instance = DockerBuild({});
    const props = (instance.build as any).props;
    expect(props.stage).toBe("build");
  });

  test("custom docker version", () => {
    const instance = DockerBuild({ dockerVersion: "24" });
    const props = (instance.build as any).props;
    const imgProps = (props.image as any).props;
    expect(imgProps.name).toBe("docker:24-cli");
    const svcProps = (props.services[0] as any).props;
    expect(svcProps.name).toBe("docker:24-dind");
  });

  test("before_script contains docker login", () => {
    const instance = DockerBuild({});
    const props = (instance.build as any).props;
    expect(props.before_script[0]).toContain("docker login");
    expect(props.before_script[0]).toContain("$CI_REGISTRY_USER");
  });

  test("script contains docker build and push", () => {
    const instance = DockerBuild({});
    const props = (instance.build as any).props;
    expect(props.script[0]).toContain("docker build");
    expect(props.script[1]).toContain("docker push");
  });

  test("build args are passed as flags", () => {
    const instance = DockerBuild({ buildArgs: { NODE_ENV: "production" } });
    const props = (instance.build as any).props;
    expect(props.script[0]).toContain("--build-arg NODE_ENV=production");
  });

  test("tagLatest adds conditional tag script", () => {
    const instance = DockerBuild({ tagLatest: true });
    const props = (instance.build as any).props;
    expect(props.script.length).toBe(3);
    expect(props.script[2]).toContain(":latest");
  });

  test("tagLatest: false omits latest tagging", () => {
    const instance = DockerBuild({ tagLatest: false });
    const props = (instance.build as any).props;
    expect(props.script.length).toBe(2);
  });

  test("custom rules are applied", () => {
    const { Rule } = require("../generated");
    const rule = new Rule({ if: "$CI_COMMIT_TAG" });
    const instance = DockerBuild({ rules: [rule] });
    const props = (instance.build as any).props;
    expect(props.rules).toHaveLength(1);
  });

  test("expandComposite produces correct name", () => {
    const expanded = expandComposite("docker", DockerBuild({}));
    expect(expanded.has("dockerBuild")).toBe(true);
    expect(expanded.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NodePipeline
// ---------------------------------------------------------------------------
describe("NodePipeline", () => {
  test("returns defaults, build, test members", () => {
    const instance = NodePipeline({});
    expect(Object.keys(instance.members)).toEqual(["defaults", "build", "test"]);
  });

  test("default image is node:22-alpine", () => {
    const instance = NodePipeline({});
    const defaultProps = (instance.defaults as any).props;
    const imgProps = (defaultProps.image as any).props;
    expect(imgProps.name).toBe("node:22-alpine");
  });

  test("custom node version", () => {
    const instance = NodePipeline({ nodeVersion: "20" });
    const defaultProps = (instance.defaults as any).props;
    const imgProps = (defaultProps.image as any).props;
    expect(imgProps.name).toBe("node:20-alpine");
  });

  test("npm cache config (default)", () => {
    const instance = NodePipeline({});
    const defaultProps = (instance.defaults as any).props;
    const cacheProps = (defaultProps.cache[0] as any).props;
    expect(cacheProps.paths).toEqual([".npm/"]);
    expect(cacheProps.key).toEqual({ files: ["package-lock.json"] });
  });

  test("pnpm cache config", () => {
    const instance = NodePipeline({ packageManager: "pnpm" });
    const defaultProps = (instance.defaults as any).props;
    const cacheProps = (defaultProps.cache[0] as any).props;
    expect(cacheProps.paths).toEqual([".pnpm-store/"]);
    expect(cacheProps.key).toEqual({ files: ["pnpm-lock.yaml"] });
  });

  test("bun cache config", () => {
    const instance = NodePipeline({ packageManager: "bun" });
    const defaultProps = (instance.defaults as any).props;
    const cacheProps = (defaultProps.cache[0] as any).props;
    expect(cacheProps.paths).toEqual([".bun/install/cache"]);
    expect(cacheProps.key).toEqual({ files: ["bun.lock"] });
  });

  test("build job has install + build script", () => {
    const instance = NodePipeline({});
    const props = (instance.build as any).props;
    expect(props.script).toEqual(["npm ci", "npm run build"]);
    expect(props.stage).toBe("build");
  });

  test("test job has install + test script", () => {
    const instance = NodePipeline({});
    const props = (instance.test as any).props;
    expect(props.script).toEqual(["npm ci", "npm run test"]);
    expect(props.stage).toBe("test");
  });

  test("build artifacts default to dist/", () => {
    const instance = NodePipeline({});
    const props = (instance.build as any).props;
    const artProps = (props.artifacts as any).props;
    expect(artProps.paths).toEqual(["dist/"]);
    expect(artProps.expire_in).toBe("1 hour");
  });

  test("custom build/test scripts", () => {
    const instance = NodePipeline({
      buildScript: "compile",
      testScript: "check",
    });
    const buildProps = (instance.build as any).props;
    const testProps = (instance.test as any).props;
    expect(buildProps.script[1]).toBe("npm run compile");
    expect(testProps.script[1]).toBe("npm run check");
  });

  test("custom install command", () => {
    const instance = NodePipeline({ installCommand: "yarn install" });
    const buildProps = (instance.build as any).props;
    expect(buildProps.script[0]).toBe("yarn install");
  });

  test("test job has JUnit report artifact", () => {
    const instance = NodePipeline({});
    const props = (instance.test as any).props;
    const artProps = (props.artifacts as any).props;
    expect(artProps.reports).toEqual({ junit: "junit.xml" });
    expect(artProps.when).toBe("always");
  });

  test("expandComposite produces 3 entries", () => {
    const expanded = expandComposite("app", NodePipeline({}));
    expect(expanded.size).toBe(3);
    expect(expanded.has("appDefaults")).toBe(true);
    expect(expanded.has("appBuild")).toBe(true);
    expect(expanded.has("appTest")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BunPipeline / PnpmPipeline presets
// ---------------------------------------------------------------------------
describe("BunPipeline preset", () => {
  test("defaults to bun package manager", () => {
    const instance = BunPipeline({});
    const buildProps = (instance.build as any).props;
    expect(buildProps.script[0]).toBe("bun install --frozen-lockfile");
    expect(buildProps.script[1]).toBe("bun run build");
  });

  test("preset defaults can be overridden", () => {
    const instance = BunPipeline({ packageManager: "npm" });
    const buildProps = (instance.build as any).props;
    expect(buildProps.script[0]).toBe("npm ci");
  });
});

describe("PnpmPipeline preset", () => {
  test("defaults to pnpm package manager", () => {
    const instance = PnpmPipeline({});
    const buildProps = (instance.build as any).props;
    expect(buildProps.script[0]).toBe("pnpm install --frozen-lockfile");
    expect(buildProps.script[1]).toBe("pnpm run build");
  });
});

// ---------------------------------------------------------------------------
// PythonPipeline
// ---------------------------------------------------------------------------
describe("PythonPipeline", () => {
  test("returns defaults, test, lint members by default", () => {
    const instance = PythonPipeline({});
    expect(Object.keys(instance.members)).toContain("defaults");
    expect(Object.keys(instance.members)).toContain("test");
    expect(Object.keys(instance.members)).toContain("lint");
  });

  test("default image is python:3.12-slim", () => {
    const instance = PythonPipeline({});
    const defaultProps = (instance.defaults as any).props;
    const imgProps = (defaultProps.image as any).props;
    expect(imgProps.name).toBe("python:3.12-slim");
  });

  test("custom python version", () => {
    const instance = PythonPipeline({ pythonVersion: "3.11" });
    const defaultProps = (instance.defaults as any).props;
    const imgProps = (defaultProps.image as any).props;
    expect(imgProps.name).toBe("python:3.11-slim");
  });

  test("defaults has venv setup in before_script", () => {
    const instance = PythonPipeline({});
    const defaultProps = (instance.defaults as any).props;
    expect(defaultProps.before_script).toContain("python -m venv .venv");
    expect(defaultProps.before_script).toContain("source .venv/bin/activate");
  });

  test("poetry mode uses poetry install", () => {
    const instance = PythonPipeline({ usePoetry: true });
    const defaultProps = (instance.defaults as any).props;
    expect(defaultProps.before_script).toContain("pip install poetry");
    expect(defaultProps.before_script).toContain("poetry install");
  });

  test("cache keyed on requirements file", () => {
    const instance = PythonPipeline({});
    const defaultProps = (instance.defaults as any).props;
    const cacheProps = (defaultProps.cache[0] as any).props;
    expect(cacheProps.key).toEqual({ files: ["requirements.txt"] });
    expect(cacheProps.paths).toEqual([".pip-cache/", ".venv/"]);
  });

  test("poetry cache keyed on poetry.lock", () => {
    const instance = PythonPipeline({ usePoetry: true });
    const defaultProps = (instance.defaults as any).props;
    const cacheProps = (defaultProps.cache[0] as any).props;
    expect(cacheProps.key).toEqual({ files: ["poetry.lock"] });
  });

  test("test job runs pytest by default", () => {
    const instance = PythonPipeline({});
    const props = (instance.test as any).props;
    expect(props.script).toContain("pytest --junitxml=report.xml --cov");
  });

  test("test job has JUnit report", () => {
    const instance = PythonPipeline({});
    const props = (instance.test as any).props;
    const artProps = (props.artifacts as any).props;
    expect(artProps.reports).toEqual({ junit: "report.xml" });
  });

  test("lint job runs ruff by default", () => {
    const instance = PythonPipeline({});
    const members = instance.members as any;
    expect(members.lint).toBeDefined();
    const props = (members.lint as any).props;
    expect(props.script).toContain("ruff check .");
  });

  test("lintCommand: null omits lint job", () => {
    const instance = PythonPipeline({ lintCommand: null });
    expect(Object.keys(instance.members)).not.toContain("lint");
  });

  test("custom test command", () => {
    const instance = PythonPipeline({ testCommand: "python -m unittest" });
    const props = (instance.test as any).props;
    expect(props.script).toContain("python -m unittest");
  });

  test("expandComposite produces correct entries", () => {
    const expanded = expandComposite("py", PythonPipeline({}));
    expect(expanded.has("pyDefaults")).toBe(true);
    expect(expanded.has("pyTest")).toBe(true);
    expect(expanded.has("pyLint")).toBe(true);
  });

  test("expandComposite without lint", () => {
    const expanded = expandComposite("py", PythonPipeline({ lintCommand: null }));
    expect(expanded.has("pyDefaults")).toBe(true);
    expect(expanded.has("pyTest")).toBe(true);
    expect(expanded.has("pyLint")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReviewApp
// ---------------------------------------------------------------------------
describe("ReviewApp", () => {
  const baseProps = {
    name: "review",
    deployScript: "kubectl apply -f k8s/",
  };

  test("returns deploy and stop members", () => {
    const instance = ReviewApp(baseProps);
    expect(Object.keys(instance.members)).toEqual(["deploy", "stop"]);
  });

  test("deploy job has environment with on_stop", () => {
    const instance = ReviewApp(baseProps);
    const props = (instance.deploy as any).props;
    const envProps = (props.environment as any).props;
    expect(envProps.name).toBe("review/$CI_COMMIT_REF_SLUG");
    expect(envProps.on_stop).toBe("review-stop");
    expect(envProps.auto_stop_in).toBe("1 week");
  });

  test("stop job has environment with action stop", () => {
    const instance = ReviewApp(baseProps);
    const props = (instance.stop as any).props;
    const envProps = (props.environment as any).props;
    expect(envProps.name).toBe("review/$CI_COMMIT_REF_SLUG");
    expect(envProps.action).toBe("stop");
  });

  test("deploy has MR rule", () => {
    const instance = ReviewApp(baseProps);
    const props = (instance.deploy as any).props;
    expect(props.rules).toHaveLength(1);
    const ruleProps = (props.rules[0] as any).props;
    expect(ruleProps.if).toBe("$CI_MERGE_REQUEST_IID");
  });

  test("stop has manual MR rule", () => {
    const instance = ReviewApp(baseProps);
    const props = (instance.stop as any).props;
    const ruleProps = (props.rules[0] as any).props;
    expect(ruleProps.if).toBe("$CI_MERGE_REQUEST_IID");
    expect(ruleProps.when).toBe("manual");
  });

  test("deploy script from string", () => {
    const instance = ReviewApp(baseProps);
    const props = (instance.deploy as any).props;
    expect(props.script).toEqual(["kubectl apply -f k8s/"]);
  });

  test("deploy script from array", () => {
    const instance = ReviewApp({
      ...baseProps,
      deployScript: ["helm upgrade --install", "kubectl rollout status"],
    });
    const props = (instance.deploy as any).props;
    expect(props.script).toEqual(["helm upgrade --install", "kubectl rollout status"]);
  });

  test("default stop script", () => {
    const instance = ReviewApp(baseProps);
    const props = (instance.stop as any).props;
    expect(props.script).toEqual(['echo "Stopping review app..."']);
  });

  test("custom stop script", () => {
    const instance = ReviewApp({ ...baseProps, stopScript: "kubectl delete -f k8s/" });
    const props = (instance.stop as any).props;
    expect(props.script).toEqual(["kubectl delete -f k8s/"]);
  });

  test("custom stage", () => {
    const instance = ReviewApp({ ...baseProps, stage: "review" });
    const deployProps = (instance.deploy as any).props;
    const stopProps = (instance.stop as any).props;
    expect(deployProps.stage).toBe("review");
    expect(stopProps.stage).toBe("review");
  });

  test("custom url pattern", () => {
    const instance = ReviewApp({
      ...baseProps,
      urlPattern: "https://$CI_ENVIRONMENT_SLUG.myapp.dev",
    });
    const props = (instance.deploy as any).props;
    const envProps = (props.environment as any).props;
    expect(envProps.url).toBe("https://$CI_ENVIRONMENT_SLUG.myapp.dev");
  });

  test("custom image is applied to both jobs", () => {
    const { Image } = require("../generated");
    const img = new Image({ name: "alpine:latest" });
    const instance = ReviewApp({ ...baseProps, image: img });
    const deployProps = (instance.deploy as any).props;
    const stopProps = (instance.stop as any).props;
    expect(deployProps.image).toBe(img);
    expect(stopProps.image).toBe(img);
  });

  test("expandComposite produces correct names", () => {
    const expanded = expandComposite("review", ReviewApp(baseProps));
    expect(expanded.size).toBe(2);
    expect(expanded.has("reviewDeploy")).toBe(true);
    expect(expanded.has("reviewStop")).toBe(true);
  });

  test("on_stop name matches kebab-case of expanded stop job", () => {
    const instance = ReviewApp({ name: "staging", deployScript: "deploy.sh" });
    const deployProps = (instance.deploy as any).props;
    const envProps = (deployProps.environment as any).props;
    // The on_stop value should be "staging-stop"
    // When expanded with prefix "staging", the stop job becomes "stagingStop"
    // which the serializer converts to "staging-stop" in YAML
    expect(envProps.on_stop).toBe("staging-stop");
  });
});
