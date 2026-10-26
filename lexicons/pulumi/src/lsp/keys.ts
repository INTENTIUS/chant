/**
 * The keys the pulumi lexicon's editor support knows (#4468): the project
 * file, a stack's config file, the workspace member entry and the
 * `pulumi.member` config namespace.
 *
 * Each entry says what the key is to Pulumi and, where chant reads it, what
 * chant does with it. The project-file keys follow Pulumi's own reference
 * for `Pulumi.yaml` (www.pulumi.com/docs/iac/concepts/projects/project-file/)
 * and the stack keys its reference for `Pulumi.<stack>.yaml`
 * (www.pulumi.com/docs/iac/concepts/config/). Neither list is exhaustive;
 * a key missing here gets no completion and no hover, and that is all.
 */

export interface KeyDoc {
  key: string;
  doc: string;
  /** Values offered after `key:`, each with its own line of documentation. */
  values?: Array<{ value: string; doc: string }>;
}

const RUNTIMES = [
  { value: "nodejs", doc: "TypeScript or JavaScript, run with Node.js" },
  { value: "python", doc: "Python" },
  { value: "go", doc: "Go" },
  { value: "dotnet", doc: ".NET (C#, F#, VB)" },
  { value: "java", doc: "Java, built with Maven or Gradle" },
  { value: "yaml", doc: "Pulumi YAML: resources, variables and outputs written in this file" },
];

/** `Pulumi.yaml`, keyed by dotted path from the document root. */
export const PROJECT_KEYS: Record<string, KeyDoc[]> = {
  "": [
    {
      key: "name",
      doc:
        "The project name (required). It is the second segment of every URN the stack writes " +
        "(`urn:pulumi:<stack>::<project>::<type>::<name>`); chant keys a member's graph nodes by the URN after its stack " +
        "and project, so renaming the project does not move them.",
    },
    {
      key: "runtime",
      doc:
        "The language the program is written in (required): a name, or `{ name, options }`. chant never runs the " +
        "program; the graph is read from the checked-in `stack-export.json`.",
      values: RUNTIMES,
    },
    { key: "description", doc: "A one-line description of the project." },
    { key: "main", doc: "The program's entry point or directory, relative to this file, when it is not this directory." },
    { key: "stackConfigDir", doc: "The directory that holds the `Pulumi.<stack>.yaml` files, when it is not this one." },
    {
      key: "backend",
      doc:
        "Where the project's stacks keep their state. chant reads `backend.url` from this file, and only from this " +
        "file, to decide what runs the member: a URL starting with `plunge` runs it on plunge.",
    },
    { key: "options", doc: "Project options, such as `refresh: always`." },
    { key: "config", doc: "Project-level config: declarations (type, description, default) and values every stack shares." },
    { key: "template", doc: "Metadata `pulumi new` reads when this project is used as a template." },
    { key: "plugins", doc: "Local provider, analyzer and language plugin binaries, by path." },
    { key: "packages", doc: "Pulumi packages the program uses, by name, for parameterized providers." },
    { key: "author", doc: "The project's author." },
    { key: "website", doc: "The project's website." },
    { key: "license", doc: "The project's license." },
    { key: "resources", doc: "Pulumi YAML only: the resources the program declares, by logical name." },
    { key: "variables", doc: "Pulumi YAML only: values computed once and referenced as `${name}`." },
    { key: "outputs", doc: "Pulumi YAML only: the stack outputs. chant reads them into other members' parameters." },
  ],
  runtime: [
    { key: "name", doc: "The runtime's name.", values: RUNTIMES },
    { key: "options", doc: "Options for the language host, such as `typescript`, `packagemanager` or `toolchain`." },
  ],
  "runtime.options": [
    { key: "typescript", doc: "nodejs: whether to compile TypeScript with ts-node (default true)." },
    { key: "nodeargs", doc: "nodejs: extra arguments passed to `node`." },
    {
      key: "packagemanager",
      doc: "nodejs: the package manager that installs dependencies.",
      values: ["npm", "yarn", "pnpm", "bun"].map((value) => ({ value, doc: value })),
    },
    {
      key: "toolchain",
      doc: "python: how dependencies are installed.",
      values: ["pip", "poetry", "uv"].map((value) => ({ value, doc: value })),
    },
    { key: "virtualenv", doc: "python: the virtual environment directory." },
    { key: "binary", doc: "go, dotnet, java: a prebuilt program binary to run instead of building one." },
  ],
  backend: [
    {
      key: "url",
      doc:
        "The state backend: `file://...`, `s3://...`, `https://api.pulumi.com` and so on. A URL starting with " +
        "`plunge` (`plunge+file://...`, `plunge://...`) makes chant run the member's preview and drift under " +
        "`plunge`. `PULUMI_BACKEND_URL` and `pulumi login` state are not read.",
    },
  ],
  options: [
    {
      key: "refresh",
      doc: "`always` refreshes before every update and preview.",
      values: [{ value: "always", doc: "refresh before every update and preview" }],
    },
  ],
};

/** `Pulumi.<stack>.yaml`, keyed by dotted path from the document root. */
export const STACK_KEYS: Record<string, KeyDoc[]> = {
  "": [
    {
      key: "config",
      doc:
        "The stack's config values, each `<namespace>:<key>`: the project's own under its name, a provider's under " +
        "the provider's (`aws:region`). chant's preview and drift run against the member's selected stack and never " +
        "change these.",
    },
    { key: "secretsprovider", doc: "The provider that encrypts this stack's secrets (`passphrase`, `awskms://...`)." },
    { key: "encryptionsalt", doc: "The salt for passphrase-encrypted secrets. Written by Pulumi; do not edit." },
    { key: "encryptedkey", doc: "The data key for a cloud secrets provider. Written by Pulumi; do not edit." },
    { key: "environment", doc: "Pulumi ESC environments this stack imports config from." },
  ],
};

/** Hover-only keys inside a stack's config. */
export const STACK_CONFIG_VALUE_KEYS: Record<string, string> = {
  secure:
    "An encrypted value. Outputs Pulumi marks secret are left out of the outputs chant reads into another member's " +
    "parameters, and chant never decrypts or prints them.",
};

/** The member kind, for `"kind": "pulumi"` in `chant.workspace.json`. */
export const MEMBER_KIND_DOC =
  "**pulumi** member kind (`@intentius/chant-lexicon-pulumi`)\n\n" +
  "A Pulumi program, found by its `Pulumi.yaml`.\n\n" +
  "- graph: the `pulumi stack export` checked in as `stack-export.json`; the program is not run\n" +
  "- change set: `pulumi preview --json`\n" +
  "- drift: `pulumi refresh --preview-only --json`, one resource at a time, or `plunge drift --stream` on plunge\n" +
  "- outputs: `pulumi stack output --json --show-secrets=false` (applied) and the preview (planned)\n\n" +
  "On plunge, `plunge preview`, `plunge stack output` and `plunge drift`. chant runs nothing else (#4476), so it " +
  "never changes the stack.";

/** `pulumi.member` in `chant.config.ts`. */
export const MEMBER_CONFIG_KEYS: KeyDoc[] = [
  {
    key: "dir",
    doc:
      "The member's directory, the one holding `Pulumi.yaml` and `stack-export.json`. A relative path resolves " +
      "against the project root (PUL101 warns on an absolute one).",
  },
  { key: "label", doc: "The prefix of the member's entity names (`<label>/<urn tail>`). Defaults to the directory's name." },
  {
    key: "engine",
    doc: "What runs the stack: `pulumi`, or `plunge`. Omit it to take it from `backend.url` in `Pulumi.yaml`.",
    values: [
      { value: "pulumi", doc: "run `pulumi preview` and `pulumi refresh --preview-only`" },
      { value: "plunge", doc: "run the same reads under `plunge`, and drift with `plunge drift --stream`" },
    ],
  },
];

export const CONFIG_NAMESPACE_KEYS: KeyDoc[] = [
  { key: "member", doc: "One pulumi workspace member read into this build's graph, from its checked-in `stack-export.json`." },
];
