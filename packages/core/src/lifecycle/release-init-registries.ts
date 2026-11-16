/**
 * What `chant release init` finds and plans for Maven, .NET and Ruby
 * projects (#5232): a `pom.xml`, `*.csproj` files or a `*.gemspec` at the
 * project's root, built once at the cut by a `release.artifacts` entry and
 * published by a `maven`, `nuget` or `rubygems` target.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** What {@link detectRegistryProjects} found. */
export interface RegistryProjectFacts {
  maven: { groupId: string | null; artifactId: string | null } | null;
  /** The `.csproj` files at the root that pack, with their package ids. */
  dotnet: { projects: Array<{ file: string; id: string }> } | null;
  ruby: { gemspec: string; name: string } | null;
}

const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

/** The project's own `groupId` and `artifactId` in a `pom.xml`, its parent's `groupId` when it has none. */
export function pomFacts(text: string): NonNullable<RegistryProjectFacts["maven"]> {
  const body = text.replace(/<!--[\s\S]*?-->/g, "");
  const top = body.replace(/<parent>[\s\S]*?<\/parent>/, "").replace(/<(dependencies|dependencyManagement|build|profiles|plugins|modules)>[\s\S]*?<\/\1>/g, "");
  const get = (s: string, tag: string) => new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(s)?.[1] ?? null;
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(body)?.[1] ?? "";
  return { groupId: get(top, "groupId") ?? get(parent, "groupId"), artifactId: get(top, "artifactId") };
}

/** The Maven, .NET and Ruby projects at `root`. */
export function detectRegistryProjects(root: string): RegistryProjectFacts {
  const pom = read(join(root, "pom.xml"));
  const files = existsSync(root) ? readdirSync(root).sort() : [];
  const projects = files
    .filter((f) => f.endsWith(".csproj"))
    .map((file) => ({ file, text: read(join(root, file)) ?? "" }))
    .filter((p) => !/<IsPackable>\s*false\s*<\/IsPackable>/i.test(p.text))
    .map((p) => ({ file: p.file, id: /<PackageId>\s*([^<]+?)\s*<\/PackageId>/.exec(p.text)?.[1] ?? p.file.slice(0, -".csproj".length) }));
  const gemspec = files.find((f) => f.endsWith(".gemspec"));
  const gemName = gemspec ? (/\.name\s*=\s*["']([^"']+)["']/.exec(read(join(root, gemspec)) ?? "")?.[1] ?? gemspec.slice(0, -".gemspec".length)) : null;
  return {
    maven: pom === null ? null : pomFacts(pom),
    dotnet: projects.length > 0 ? { projects } : null,
    ruby: gemspec && gemName ? { gemspec, name: gemName } : null,
  };
}

/** What the plan adds for these projects. */
export interface RegistryPlan {
  artifacts: Json[];
  publish: Json[];
  reasons: string[];
  notes: string[];
  registry: string[];
  /** Variables for `release.workflow.env`, on GitHub and Forgejo. */
  env: Record<string, string>;
}

/** The artifacts, targets and steps for the Maven, .NET and Ruby projects found. */
export function planRegistryTargets(facts: RegistryProjectFacts, o: { forge: "github" | "gitlab" | "forgejo"; repo: string; workflowName: string }): RegistryPlan {
  const plan: RegistryPlan = { artifacts: [], publish: [], reasons: [], notes: [], registry: [], env: {} };
  const secret = (name: string) => {
    if (o.forge !== "gitlab") plan.env[name] = `\${{ secrets.${name} }}`;
  };
  const store = o.forge === "gitlab" ? "masked CI/CD variable" : "secret";
  const trusted = o.forge === "gitlab" ? `GitLab CI/CD naming ${o.repo} and the top-level pipeline file .gitlab-ci.yml` : `GitHub Actions naming ${o.repo} and the workflow file ${o.workflowName}`;

  const mv = facts.maven;
  if (mv) {
    const coord = mv.groupId && mv.artifactId ? `${mv.groupId}:${mv.artifactId}` : "the project";
    plan.artifacts.push({ name: "maven", build: "mvn -B -ntp deploy -DaltDeploymentRepository=local::file:./target/staging-deploy && cd target/staging-deploy && zip -qr ../central-bundle.zip .", outputs: ["target/central-bundle.zip"] });
    plan.publish.push({ type: "maven", bundle: "artifact:maven" });
    plan.reasons.push(`release.artifacts: ${coord} is deployed once at the cut into target/staging-deploy, zipped as a Central Portal bundle that the release records`);
    plan.reasons.push(`maven target: the bundle, uploaded to the Central Portal and validated at the stage, published to Maven Central at the reveal`);
    plan.notes.push("pom.xml's version is published as written: set it to the release's label before the cut, or use ${revision} and pass -Drevision=\"$CHANT_RELEASE_LABEL\" in the build. Maven Central takes only signed files: the build must sign them, such as with maven-gpg-plugin.");
    secret("MAVEN_CENTRAL_USERNAME");
    secret("MAVEN_CENTRAL_PASSWORD");
    plan.registry.push(`Maven Central ${coord}: verify the namespace ${mv.groupId ?? "<groupId>"} at https://central.sonatype.com, generate a user token, and store its name and password as the ${store}s MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD. Give the cut job the GPG key the build signs with, and publish the key's public half to a keyserver.`);
  }

  const dn = facts.dotnet;
  if (dn) {
    const ids = dn.projects.map((p) => p.id).join(", ");
    const pack = dn.projects.map((p) => `dotnet pack ${p.file} -c Release -o dist/nuget -p:Version="$CHANT_RELEASE_LABEL"`).join(" && ");
    plan.artifacts.push({ name: "nuget", build: pack, outputs: ["dist/nuget/*.nupkg"] });
    const tp = o.forge !== "forgejo";
    plan.publish.push({ type: "nuget", packages: ["artifact:nuget"], auth: tp ? "trusted-publishing" : "token" });
    plan.reasons.push(`release.artifacts: ${ids} packed once at the cut with dotnet pack, at the release's label, and the release records each .nupkg`);
    plan.reasons.push(`nuget target: the recorded packages, pushed to nuget.org ${tp ? "with trusted publishing" : "with the API key in NUGET_API_KEY"}`);
    if (tp) {
      secret("NUGET_USER");
      plan.registry.push(`nuget.org ${ids}: add a trusted publishing policy for ${trusted}, and store the nuget.org profile name of the user who created it (not the email address) as the ${store} NUGET_USER.`);
    } else {
      secret("NUGET_API_KEY");
      plan.registry.push(`nuget.org ${ids}: create an API key that may push ${dn.projects.length === 1 ? "the package" : "the packages"} and store it as the secret NUGET_API_KEY; nuget.org has no trusted publishing for this forge.`);
    }
  }

  const rb = facts.ruby;
  if (rb) {
    plan.artifacts.push({ name: "gem", build: `gem build ${rb.gemspec} && mkdir -p dist/gem && mv ${rb.name}-*.gem dist/gem/`, outputs: ["dist/gem/*.gem"] });
    const tp = o.forge === "github";
    plan.publish.push({ type: "rubygems", gems: ["artifact:gem"], auth: tp ? "trusted-publishing" : "token" });
    plan.reasons.push(`release.artifacts: ${rb.name} is built once at the cut with gem build, and the release records the .gem`);
    plan.reasons.push(`rubygems target: the recorded gem, pushed to RubyGems.org ${tp ? "with trusted publishing" : "with the API key in GEM_HOST_API_KEY"}`);
    plan.notes.push(`${rb.gemspec}'s version is published as the gemspec sets it: set it to the release's label before the cut, or read it from CHANT_RELEASE_LABEL in the gemspec.`);
    if (tp) plan.registry.push(`RubyGems.org ${rb.name}: add a trusted publisher for GitHub Actions naming ${o.repo} and the workflow file ${o.workflowName} (a pending trusted publisher if the gem does not exist yet).`);
    else {
      secret("GEM_HOST_API_KEY");
      plan.registry.push(`RubyGems.org ${rb.name}: create an API key with the push scope and store it as the ${store} GEM_HOST_API_KEY; RubyGems.org has no trusted publishing for this forge.`);
    }
  }
  return plan;
}
