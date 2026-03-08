/**
 * Example template generators for init-lexicon scaffold.
 */

export function generateExamplePackageJson(name: string): string {
  return JSON.stringify(
    {
      name: `@intentius/chant-lexicon-${name}-example-getting-started`,
      version: "0.0.1",
      private: true,
      dependencies: {
        [`@intentius/chant-lexicon-${name}`]: "workspace:*",
        "@intentius/chant": "workspace:*",
      },
    },
    null,
    2,
  ) + "\n";
}

export function generateExampleInfraTs(name: string, names: { packageName: string }): string {
  return `/**
 * Getting-started example for the ${name} lexicon.
 *
 * TODO: Replace with a real infrastructure definition
 * that uses resources from the ${name} lexicon.
 */

// import { SomeResource } from "${names.packageName}";
//
// export const myResource = SomeResource("example", {
//   // properties...
// });
`;
}
