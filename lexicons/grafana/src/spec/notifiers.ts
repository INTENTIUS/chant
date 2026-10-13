/**
 * Turns Grafana's `GET /api/alert-notifiers?version=2` response into
 * `src/contact-point-settings.gen.ts`: a settings interface per
 * integration plus the option table the checks read. Only the creatable
 * `v1` options of each integration are used (the `v0mimir*` versions are
 * the legacy Mimir shapes Grafana cannot create), except for integrations
 * with no creatable version, which use their current one.
 */

export const GRAFANA_NOTIFIERS_SOURCE = {
  image: "grafana/grafana",
  version: "13.2.2",
  commit: "1bea008f",
  endpoint: "/api/alert-notifiers?version=2",
} as const;

export interface NotifierOption {
  element: string;
  inputType: string;
  label: string;
  description: string;
  propertyName: string;
  selectOptions: Array<{ value: string; label: string }> | null;
  showWhen: { field: string; is: string };
  required: boolean;
  secure: boolean;
  dependsOn: string;
  subformOptions: NotifierOption[] | null;
}

export interface NotifierResponse {
  type: string;
  currentVersion: string;
  name: string;
  description: string;
  deprecated?: boolean;
  versions: Array<{ typeAlias?: string; version: string; canCreate: boolean; options: NotifierOption[] }>;
}

const pascal = (s: string) => s.replace(/(^|[-_])(\w)/g, (_, __, c: string) => c.toUpperCase());
const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (s: string) => (KEY.test(s) ? s : JSON.stringify(s));
const doc = (text: string, indent: string) => {
  const t = text.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim();
  return t ? `${indent}/** ${t} */\n` : "";
};

/** How an option's value is written in settings. */
function kind(o: NotifierOption): string {
  switch (o.element) {
    case "checkbox": return "boolean";
    case "select": return "select";
    case "key_value_map": return "map";
    case "string_array": return "strings";
    case "subform": return "object";
    case "subform_array": return "objects";
    default: return o.inputType === "number" ? "number" : "string";
  }
}

/** Required means required every time: an option shown or needed only given another one is not. */
const alwaysRequired = (o: NotifierOption) => o.required && !o.dependsOn && !o.showWhen.field;

export function renderNotifiers(notifiers: NotifierResponse[]): string {
  const interfaces: string[] = [];
  const table: string[] = [];
  const byType: string[] = [];

  const optionType = (o: NotifierOption, iface: string): string => {
    switch (kind(o)) {
      case "boolean": return "boolean";
      case "number": return "number";
      case "map": return "Record<string, string>";
      case "strings": return "string[]";
      case "select": {
        const values = (o.selectOptions ?? []).map((s) => s.value);
        const numeric = values.length > 0 && values.every((v) => v !== "" && !Number.isNaN(Number(v)));
        return [...values.map((v) => JSON.stringify(v)), ...(numeric ? values.map(Number) : [])].join(" | ") || "string";
      }
      case "object": return emit(`${iface}${pascal(o.propertyName)}`, o.subformOptions ?? [], o.description);
      case "objects": return `${emit(`${iface}${pascal(o.propertyName)}Item`, o.subformOptions ?? [], o.description)}[]`;
      default: return "string";
    }
  };

  const emit = (name: string, options: NotifierOption[], description: string): string => {
    let body = "";
    for (const o of options) {
      const t = optionType(o, name);
      const notes = [o.description && !/[.!?]$/.test(o.description.trim()) ? `${o.description.trim()}.` : o.description, o.secure ? "Secret: write it as $__env{NAME} or $__file{/path}." : ""].filter(Boolean).join(" ");
      body += `${doc(notes, "  ")}  ${key(o.propertyName)}${alwaysRequired(o) ? "" : "?"}: ${t};\n`;
    }
    interfaces.push(`${doc(description, "")}export interface ${name} {\n${body}}\n`);
    return name;
  };

  const renderOptions = (options: NotifierOption[], indent: string): string =>
    options
      .map((o) => {
        const parts = [`key: ${JSON.stringify(o.propertyName)}`, `kind: ${JSON.stringify(kind(o))}`];
        if (alwaysRequired(o)) parts.push("required: true");
        if (o.secure) parts.push("secure: true");
        if (kind(o) === "select") parts.push(`values: ${JSON.stringify((o.selectOptions ?? []).map((s) => s.value))}`);
        if (o.subformOptions?.length) parts.push(`options: [\n${renderOptions(o.subformOptions, indent + "  ")}\n${indent}]`);
        return `${indent}{ ${parts.join(", ")} },`;
      })
      .join("\n");

  for (const n of [...notifiers].sort((a, b) => a.type.toLowerCase().localeCompare(b.type.toLowerCase()))) {
    const version = n.versions.find((v) => v.version === "v1") ?? n.versions.find((v) => v.version === n.currentVersion)!;
    // LINE is listed under its display type; provisioning files use the alias.
    const id = (version.typeAlias ?? n.type).toLowerCase();
    const iface = `${pascal(id)}Settings`;
    emit(iface, version.options, `${n.name}: ${n.description}`);
    byType.push(`  ${key(id)}: ${iface};`);
    table.push(
      `  ${key(id)}: {\n    name: ${JSON.stringify(n.name)},\n    creatable: ${version.canCreate},\n${n.deprecated ? "    deprecated: true,\n" : ""}    options: [\n${renderOptions(version.options, "      ")}\n    ],\n  },`,
    );
  }

  const S = GRAFANA_NOTIFIERS_SOURCE;
  return `// Generated by \`just fetch-notifiers\` (src/spec/fetch-notifiers-cli.ts). Do not edit.
// Source: GET ${S.endpoint} on ${S.image}:${S.version} (commit ${S.commit}); the same options on 12.4.11.
// The creatable (v1) options of each integration: names, value kinds, required and secure flags, select values.

${interfaces.join("\n")}
/** The settings type of each integration, by the \`type\` a contact point receiver uses. */
export interface ContactPointSettingsByType {
${byType.join("\n")}
}

export type NotifierOptionKind = "string" | "number" | "boolean" | "select" | "map" | "strings" | "object" | "objects";

export interface NotifierOptionSchema {
  key: string;
  kind: NotifierOptionKind;
  /** Required whenever the integration is used (not only given another option). */
  required?: true;
  /** Grafana stores it encrypted: write it as \`$__env{NAME}\` or \`$__file{/path}\`. */
  secure?: true;
  values?: readonly string[];
  /** The keys of an \`object\` or \`objects\` option. */
  options?: readonly NotifierOptionSchema[];
}

export interface NotifierSchema {
  name: string;
  /** False when Grafana lists the integration but no longer creates it. */
  creatable: boolean;
  deprecated?: true;
  options: readonly NotifierOptionSchema[];
}

export const CONTACT_POINT_NOTIFIERS: Readonly<Record<keyof ContactPointSettingsByType, NotifierSchema>> = {
${table.join("\n")}
};
`;
}
