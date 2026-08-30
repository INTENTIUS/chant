/**
 * Getting-started example for the render lexicon.
 *
 * A Postgres database and a web service wired to it — the smallest deploy that
 * shows the two things this lexicon does that a `render.yaml` cannot: a typed
 * declaration checked at build time, and a cross-resource attribute
 * (`db.internalConnectionString`) resolved from the live database at apply
 * time. The owner comes from Render.OwnerId (RENDER_OWNER_ID); the region from
 * Render.Region (RENDER_REGION, defaulting to "oregon").
 */
import {
  WebService,
  WebServiceDetails,
  NativeEnvironmentDetails,
  EnvVar,
  GeneratedEnvVar,
  Postgres,
  Render,
} from "@intentius/chant-lexicon-render";

const db = new Postgres({
  name: "getting-started-db",
  plan: "free",
  version: "16",
  region: Render.Region,
});

const web = new WebService({
  name: "getting-started-web",
  repo: "https://github.com/render-examples/express-hello-world",
  branch: "main",
  serviceDetails: new WebServiceDetails({
    runtime: "node",
    plan: "starter",
    region: Render.Region,
    envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }),
  }),
  envVars: [
    new EnvVar({ key: "DATABASE_URL", value: db.internalConnectionString }),
    new GeneratedEnvVar({ key: "SESSION_SECRET", generateValue: true }),
  ],
});

export { db, web };
