// The npm packages ship through release.publish in chant.config.ts, so this
// component deploys nothing. A cut needs one component to compile (#4040).
export const packages = { name: "packages", dependsOn: [], deploy: [] };
