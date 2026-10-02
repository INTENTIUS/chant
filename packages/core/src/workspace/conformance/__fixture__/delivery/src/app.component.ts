/**
 * The component that deploys the app. Its contract names the composite kind
 * it deploys, so `chant workspace graph --composites` joins it to the `app`
 * instance in app.ts.
 */
import type { Component } from "@intentius/chant/components/component";

export const appComponent: Component = {
  name: "app",
  archetype: "service",
  composites: ["WebService"],
  dependsOn: [],
  deploy: [],
};
