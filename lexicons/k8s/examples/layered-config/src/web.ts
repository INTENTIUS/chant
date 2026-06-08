// One composite, instantiated once per environment from layered config.
//
// Each call is the blessed composite factory call with a static (const) prop
// bag — the layering already happened in config.ts. Per-environment names
// (`web-dev`/`web-staging`/`web-prod`) keep the three stacks' resources
// distinct in a single build.
import { WebApp } from "@intentius/chant-lexicon-k8s";
import { dev, staging, prod } from "./config";

export const devApp = WebApp(dev);
export const stagingApp = WebApp(staging);
export const prodApp = WebApp(prod);
