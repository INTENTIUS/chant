import { loadLexiconRegistry } from "@intentius/chant/codegen/registry";
import { createRequire } from "module";
import type { TemplateIR, ResourceIR, ParameterIR, ConditionIR, OutputIR } from "@intentius/chant/import/parser";
const require = createRequire(import.meta.url);
import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import { topoSort } from "@intentius/chant/codegen/topo-sort";
import { hasIntrinsicInValue, irUsesIntrinsic, collectDependencies } from "@intentius/chant/import/ir-utils";
import { join } from "path";

/**
 * TypeScript code generator for CloudFormation templates
 */
export class CFGenerator implements TypeScriptGenerator {
  /** One `main.ts` holds the whole template. Split files would each need the
   * parameters, conditions and resources the others declare. */
  readonly ownsLayout = true;
  private typeToClass: Map<string, string>;
  private allClassNames: Set<string>;
  /** resourceType -> (property name on the class -> CloudFormation attribute name) */
  private attrsByType: Map<string, Record<string, string>>;
  /** Resource classes imported under another name, because a logical id in
   * the template is the class's own name (`InternetGateway`). */
  private classAliases: Map<string, string> = new Map();

  constructor() {
    // Reverse lookup from the generated registry: resourceType → className.
    // Loaded through core so a missing registry says what to run rather than
    // "Cannot find module .../dist/meta.json" (#1367).
    const meta = loadLexiconRegistry(join(import.meta.dirname, "../.."), "aws");
    this.typeToClass = new Map();
    this.allClassNames = new Set();
    this.attrsByType = new Map();
    for (const [className, entry] of Object.entries(meta)) {
      if (entry.kind === "resource" && !className.includes("_")) {
        this.typeToClass.set(entry.resourceType, className);
        this.allClassNames.add(className);
        // The aws registry also carries each class's attribute map.
        this.attrsByType.set(entry.resourceType, (entry as { attrs?: Record<string, string> }).attrs ?? {});
      }
    }
  }

  /**
   * Generate TypeScript files from intermediate representation
   */
  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];

    this.classAliases = this.computeClassAliases(ir);
    // Collect the set of imported class names so we can detect variable name conflicts
    const importedSymbols = this.collectImportedSymbols(ir);

    // Generate imports
    lines.push(this.generateImports(ir));
    lines.push("");

    // Template-level Description and Metadata
    const sections = this.generateTemplateSections(ir, importedSymbols);
    if (sections.length > 0) {
      lines.push(...sections, "");
    }

    // Generate parameters
    for (const param of ir.parameters) {
      lines.push(this.generateParameter(param, importedSymbols));
    }

    if (ir.parameters.length > 0) {
      lines.push("");
    }

    // Generate conditions in dependency order ({ Condition: ... } references
    // point at earlier declarations) — #2069
    const conditions = ir.conditions ?? [];
    const sortedConditions = this.sortConditions(conditions);
    for (const condition of sortedConditions) {
      lines.push(this.generateCondition(condition, ir, importedSymbols));
    }

    if (conditions.length > 0) {
      lines.push("");
    }

    // Generate resources in dependency order
    const sortedResources = this.sortByDependencies(ir.resources);
    for (const resource of sortedResources) {
      lines.push(this.generateResource(resource, ir, importedSymbols));
    }

    // Generate outputs (#2069)
    const outputs = ir.outputs ?? [];
    if (outputs.length > 0) {
      lines.push("");
      for (const output of outputs) {
        lines.push(this.generateOutput(output, ir, importedSymbols));
      }
    }

    return [
      {
        path: "main.ts",
        content: lines.join("\n") + "\n",
      },
    ];
  }

  /**
   * Collect the set of symbols that will be imported (class names, intrinsics, etc.)
   */
  private collectImportedSymbols(ir: TemplateIR): Set<string> {
    const symbols = new Set<string>();
    if (ir.parameters.length > 0) symbols.add("Parameter");
    if ((ir.conditions ?? []).length > 0) symbols.add("Condition");
    if ((ir.outputs ?? []).length > 0) symbols.add("stackOutput");
    const intrinsics = ["Sub", "Ref", "If", "Join", "Select", "Split", "Base64", "GetAZs", "Equals", "And", "Or", "Not"] as const;
    for (const name of intrinsics) {
      if (irUsesIntrinsic(ir, name)) symbols.add(name);
    }
    // Outputs whose value is a Ref envelope render as Ref(<var>) (#2069)
    if ((ir.outputs ?? []).some((o) => hasIntrinsicInValue(o.value, "Ref"))) symbols.add("Ref");
    // A Sub that names a parameter or resource renders it as Ref(<var>), and an
    // attribute the class does not expose renders as GetAtt("<id>", "<attr>").
    const uses = this.scanGeneratedIntrinsics(ir);
    if (uses.ref) symbols.add("Ref");
    if (uses.getAtt) symbols.add("GetAtt");
    if (this.needsAWSPseudo(ir)) symbols.add("AWS");
    for (const resource of ir.resources) {
      const parsed = this.parseResourceType(resource.type);
      if (parsed) symbols.add(this.classAliases.get(parsed.resourceClass) ?? parsed.resourceClass);
    }
    if (typeof ir.metadata?.description === "string") symbols.add("templateDescription");
    if (ir.metadata?.templateMetadata !== undefined) symbols.add("templateMetadata");
    return symbols;
  }

  /**
   * Resolve a logical ID to a safe variable name, suffixing with _ if it conflicts with an imported symbol
   */
  private safeVarName(name: string, importedSymbols: Set<string>): string {
    return importedSymbols.has(name) ? name + "_" : name;
  }

  /**
   * The property on the generated class that reads `attribute` of the
   * resource `logicalId`, or undefined when the class has none. A dotted
   * CloudFormation attribute (`Endpoint.Address`) maps to its underscored
   * property (`Endpoint_Address`).
   */
  private attrProperty(logicalId: string, attribute: string, ir: TemplateIR): string | undefined {
    const resource = ir.resources.find((r) => r.logicalId === logicalId);
    if (!resource || !this.parseResourceType(resource.type)) return undefined;
    const attrs = this.attrsByType.get(resource.type) ?? {};
    const key = Object.keys(attrs).find((k) => attrs[k] === attribute);
    return key !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : undefined;
  }

  /**
   * An attribute read: `<var>.<property>` when the class exposes the
   * attribute, else `GetAtt("<id>", "<attr>")`. CloudFormation accepts
   * GetAtt on some writable properties (`AWS::SQS::Queue` `QueueName`) that
   * the class does not list, and reading those as a property gives
   * undefined.
   */
  private attrExpr(logicalId: string, attribute: string, ir: TemplateIR, importedSymbols: Set<string>): string {
    const prop = this.attrProperty(logicalId, attribute, ir);
    if (prop !== undefined) return `${this.safeVarName(logicalId, importedSymbols)}.${prop}`;
    return `GetAtt(${JSON.stringify(logicalId)}, ${JSON.stringify(attribute)})`;
  }

  /** Whether `name` is a parameter or resource the template declares. */
  private isDeclaredName(name: string, ir: TemplateIR): boolean {
    return ir.parameters.some((p) => p.name === name) || ir.resources.some((r) => r.logicalId === name);
  }

  /**
   * Which of Ref and GetAtt the generated source calls beyond the IR's own
   * Ref and GetAtt envelopes: Sub interpolations of a declared name, and
   * attribute reads the class does not expose.
   */
  private scanGeneratedIntrinsics(ir: TemplateIR): { ref: boolean; getAtt: boolean } {
    const uses = { ref: false, getAtt: false };
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const obj = value as Record<string, unknown>;
      if (obj.__intrinsic === "GetAtt") {
        if (this.attrProperty(obj.logicalId as string, obj.attribute as string, ir) === undefined) uses.getAtt = true;
      } else if (obj.__intrinsic === "Sub") {
        const variables = (obj.variables ?? {}) as Record<string, unknown>;
        for (const m of (obj.template as string).matchAll(/\$\{([^}]+)\}/g)) {
          const expr = m[1];
          if (expr.startsWith("AWS::") || expr.startsWith("!") || expr in variables) continue;
          const dot = expr.indexOf(".");
          if (dot < 0) uses.ref = true;
          else if (this.attrProperty(expr.slice(0, dot), expr.slice(dot + 1), ir) === undefined) uses.getAtt = true;
        }
      }
      for (const v of Object.values(obj)) visit(v);
    };
    for (const v of this.generatedValues(ir)) visit(v);
    return uses;
  }

  /** Every name the template declares: parameters, resources, conditions, outputs. */
  private declaredNames(ir: TemplateIR): Set<string> {
    return new Set([
      ...ir.parameters.map((p) => p.name),
      ...ir.resources.map((r) => r.logicalId),
      ...(ir.conditions ?? []).map((c) => c.name),
      ...(ir.outputs ?? []).map((o) => o.name),
    ]);
  }

  /**
   * A resource class whose name the template also uses for something it
   * declares is imported under an alias (`InternetGateway as
   * InternetGatewayResource`), so the declaration keeps its name. Suffixing
   * the declaration instead would change its logical id.
   */
  private computeClassAliases(ir: TemplateIR): Map<string, string> {
    const declared = this.declaredNames(ir);
    const aliases = new Map<string, string>();
    for (const resource of ir.resources) {
      const cls = this.parseResourceType(resource.type)?.resourceClass;
      if (!cls || !declared.has(cls) || aliases.has(cls)) continue;
      let alias = `${cls}Resource`;
      for (let i = 2; declared.has(alias) || this.allClassNames.has(alias); i++) alias = `${cls}Resource${i}`;
      aliases.set(cls, alias);
    }
    return aliases;
  }

  /** `templateDescription(...)` and `templateMetadata(...)` for the template's own sections. */
  private generateTemplateSections(ir: TemplateIR, importedSymbols: Set<string>): string[] {
    const declared = this.declaredNames(ir);
    const freeName = (base: string) => {
      let v = base;
      for (let i = 2; declared.has(v) || importedSymbols.has(v); i++) v = `${base}${i}`;
      declared.add(v);
      return v;
    };
    const lines: string[] = [];
    if (typeof ir.metadata?.description === "string") {
      lines.push(`export const ${freeName("description")} = templateDescription(${JSON.stringify(ir.metadata.description)});`);
    }
    if (ir.metadata?.templateMetadata !== undefined) {
      const value = this.generateValue(ir.metadata.templateMetadata, ir, importedSymbols);
      lines.push(`export const ${freeName("metadata")} = templateMetadata(${value});`);
    }
    return lines;
  }

  /**
   * Generate import statements
   */
  private generateImports(ir: TemplateIR): string {
    // Everything comes from the flat @intentius/chant-lexicon-aws package,
    // and the needed symbol set is exactly what collectImportedSymbols
    // computes for variable-name conflict detection.
    const aliasOf = new Map([...this.classAliases].map(([cls, alias]) => [alias, cls]));
    const allImports = [...this.collectImportedSymbols(ir)].map((s) => (aliasOf.has(s) ? `${aliasOf.get(s)} as ${s}` : s));
    if (allImports.length === 0) {
      return "";
    }
    return `import { ${allImports.join(", ")} } from "@intentius/chant-lexicon-aws";`;
  }

  /**
   * Parse AWS resource type into service and class names.
   * Returns null for unknown/unsupported types (Custom::*, third-party, etc.)
   */
  private parseResourceType(type: string): { service: string; resourceClass: string } | null {
    const className = this.typeToClass.get(type);
    if (!className) return null;
    const parts = type.split("::");
    return {
      service: parts[1]?.toLowerCase() ?? "unknown",
      resourceClass: className,
    };
  }

  /**
   * Check if AWS pseudo-parameters are used
   */
  private needsAWSPseudo(ir: TemplateIR): boolean {
    return this.generatedValues(ir).some((v) => this.hasAWSPseudo(v));
  }

  /** Every IR value the generator writes as source. */
  private generatedValues(ir: TemplateIR): unknown[] {
    return [
      ...ir.resources.flatMap((r) => [r.properties, r.metadata, r.attributes]),
      ...(ir.conditions ?? []).map((c) => c.expression),
      ...(ir.outputs ?? []).flatMap((o) => [o.value, o.exportName]),
      ir.metadata?.templateMetadata,
    ];
  }

  /**
   * Recursively check for AWS pseudo-parameter references
   */
  private hasAWSPseudo(value: unknown): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    if (Array.isArray(value)) {
      return value.some((item) => this.hasAWSPseudo(item));
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (obj.__intrinsic === "Ref") {
        const name = obj.name as string;
        return name.startsWith("AWS::");
      }
      if (obj.__intrinsic === "Sub") {
        const template = obj.template as string;
        return template.includes("${AWS::");
      }
      return Object.values(obj).some((v) => this.hasAWSPseudo(v));
    }

    return false;
  }

  /**
   * Sort resources by dependencies
   */
  private sortByDependencies(resources: ResourceIR[]): ResourceIR[] {
    const resourceIds = new Set(resources.map((r) => r.logicalId));
    return topoSort(
      resources,
      (r) => r.logicalId,
      (r) => {
        const extraDeps = new Set<string>();
        // DependsOn names a resource that is generated as a variable reference.
        const dependsOn = r.attributes?.DependsOn;
        for (const d of Array.isArray(dependsOn) ? dependsOn : dependsOn !== undefined ? [dependsOn] : []) {
          if (typeof d === "string" && resourceIds.has(d)) extraDeps.add(d);
        }
        const deps = collectDependencies({ properties: r.properties, metadata: r.metadata, attributes: r.attributes }, (obj) => {
          if (obj.__intrinsic === "Ref") {
            const name = obj.name as string;
            return name.startsWith("AWS::") ? null : name;
          }
          if (obj.__intrinsic === "GetAtt") {
            return obj.logicalId as string;
          }
          if (obj.__intrinsic === "Sub") {
            const tpl = obj.template as string;
            const re = /\$\{([^}]+)\}/g;
            let m;
            while ((m = re.exec(tpl)) !== null) {
              const expr = m[1];
              if (!expr.startsWith("AWS::")) {
                const id = expr.split(".")[0];
                if (resourceIds.has(id)) extraDeps.add(id);
              }
            }
            return null;
          }
          return null;
        });
        for (const d of extraDeps) deps.add(d);
        return [...deps];
      },
    );
  }

  /**
   * Sort conditions so `{ Condition: ... }` references point at earlier
   * declarations (#2069).
   */
  private sortConditions(conditions: ConditionIR[]): ConditionIR[] {
    return topoSort(
      conditions,
      (c) => c.name,
      (c) => [
        ...collectDependencies(c.expression, (obj) =>
          obj.__intrinsic === "ConditionRef" ? (obj.name as string) : null,
        ),
      ],
    );
  }

  /**
   * Render a condition reference as the condition's variable when the
   * template declares it, or as a literal name string when it doesn't (an
   * undeclared reference stays visible rather than breaking generation).
   */
  private conditionVarRef(name: string, ir: TemplateIR, importedSymbols: Set<string>): string {
    const declared = (ir.conditions ?? []).some((c) => c.name === name);
    return declared ? this.safeVarName(name, importedSymbols) : JSON.stringify(name);
  }

  /**
   * Generate a condition declaration (#2069)
   */
  private generateCondition(condition: ConditionIR, ir: TemplateIR, importedSymbols: Set<string>): string {
    const varName = this.safeVarName(condition.name, importedSymbols);
    const exprStr = this.generateValue(condition.expression, ir, importedSymbols);
    return `export const ${varName} = new Condition(${exprStr});`;
  }

  /**
   * Generate an output declaration as stackOutput(...) (#2069)
   */
  private generateOutput(output: OutputIR, ir: TemplateIR, importedSymbols: Set<string>): string {
    const varName = this.safeVarName(output.name, importedSymbols);

    // A bare Ref envelope becomes Ref(<var>) — stackOutput takes an intrinsic
    // or attribute reference, not the resource/parameter object itself.
    let valueStr: string;
    const value = output.value as Record<string, unknown> | null;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && value.__intrinsic === "Ref" && !(value.name as string).startsWith("AWS::")) {
      valueStr = `Ref(${this.safeVarName(value.name as string, importedSymbols)})`;
    } else {
      valueStr = this.generateValue(output.value, ir, importedSymbols);
    }

    const opts: string[] = [];
    if (output.description) opts.push(`description: ${JSON.stringify(output.description)}`);
    if (output.exportName !== undefined) {
      opts.push(`exportName: ${this.generateValue(output.exportName, ir, importedSymbols)}`);
    }
    if (output.condition) {
      opts.push(`condition: ${this.conditionVarRef(output.condition, ir, importedSymbols)}`);
    }
    // Every output names its lexicon. A literal, or a GetAtt written by name,
    // has no entity to derive it from, and an output without one is dropped
    // at serialization.
    opts.push(`lexicon: "aws"`);

    return `export const ${varName} = stackOutput(${valueStr}, { ${opts.join(", ")} });`;
  }

  /**
   * Generate a parameter declaration
   */
  private generateParameter(param: ParameterIR, importedSymbols: Set<string>): string {
    const varName = this.safeVarName(param.name, importedSymbols);
    const opts: string[] = [];
    if (param.description) opts.push(`description: ${JSON.stringify(param.description)}`);
    if (param.defaultValue !== undefined) opts.push(`defaultValue: ${JSON.stringify(param.defaultValue)}`);
    for (const [key, value] of Object.entries(param.constraints ?? {})) {
      opts.push(`${key.charAt(0).toLowerCase()}${key.slice(1)}: ${JSON.stringify(value)}`);
    }
    if (opts.length > 0) {
      return `export const ${varName} = new Parameter("${param.type}", { ${opts.join(", ")} });`;
    }
    return `export const ${varName} = new Parameter("${param.type}");`;
  }

  /**
   * Generate a resource declaration, or a comment if the type is unknown
   */
  private generateResource(resource: ResourceIR, ir: TemplateIR, importedSymbols: Set<string>): string {
    const parsed = this.parseResourceType(resource.type);
    if (!parsed) {
      const varName = this.safeVarName(resource.logicalId, importedSymbols);
      return `// Unsupported type: ${resource.type}\nexport const ${varName} = "${resource.logicalId}";`;
    }
    const varName = this.safeVarName(resource.logicalId, importedSymbols);
    const resourceClass = this.classAliases.get(parsed.resourceClass) ?? parsed.resourceClass;
    const propsStr = this.generateProps(resource.properties, ir, importedSymbols);

    // Resource attributes -> the attributes argument: Condition (#2069),
    // DependsOn, the policies, and Metadata.
    const attrs: string[] = [];
    if (resource.condition) {
      attrs.push(`Condition: ${this.conditionVarRef(resource.condition, ir, importedSymbols)}`);
    }
    for (const [key, value] of Object.entries(resource.attributes ?? {})) {
      const valueStr = key === "DependsOn"
        ? this.generateDependsOn(value, ir, importedSymbols)
        : this.generateValue(value, ir, importedSymbols);
      attrs.push(`${key}: ${valueStr}`);
    }
    if (resource.metadata !== undefined) {
      attrs.push(`Metadata: ${this.generateValue(resource.metadata, ir, importedSymbols)}`);
    }
    if (attrs.length > 0) {
      return `export const ${varName} = new ${resourceClass}(${propsStr}, { ${attrs.join(", ")} });`;
    }

    if (propsStr === "{}") {
      return `export const ${varName} = new ${resourceClass}();`;
    }

    return `export const ${varName} = new ${resourceClass}(${propsStr});`;
  }

  /**
   * DependsOn as the variables of the resources it names, so the generated
   * source references them. A name the template does not declare as a
   * supported resource stays a string.
   */
  private generateDependsOn(value: unknown, ir: TemplateIR, importedSymbols: Set<string>): string {
    const one = (d: unknown) =>
      typeof d === "string" && ir.resources.some((r) => r.logicalId === d && this.parseResourceType(r.type))
        ? this.safeVarName(d, importedSymbols)
        : this.generateValue(d, ir, importedSymbols);
    return Array.isArray(value) ? `[${value.map(one).join(", ")}]` : one(value);
  }

  /**
   * Generate property object as TypeScript
   */
  private generateProps(props: Record<string, unknown>, ir: TemplateIR, importedSymbols: Set<string>): string {
    if (Object.keys(props).length === 0) {
      return "{}";
    }

    const entries = Object.entries(props).map(([key, value]) => {
      const propName = this.toPropName(key);
      const valueStr = this.generateValue(value, ir, importedSymbols);
      return `  ${propName}: ${valueStr}`;
    });

    return `{\n${entries.join(",\n")},\n}`;
  }

  /**
   * Generate a value as TypeScript
   */
  private generateValue(value: unknown, ir: TemplateIR, importedSymbols: Set<string> = new Set()): string {
    if (value === null || value === undefined) {
      return "undefined";
    }

    if (typeof value === "string") {
      return JSON.stringify(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      const items = value.map((item) => this.generateValue(item, ir, importedSymbols));
      return `[${items.join(", ")}]`;
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;

      // Handle intrinsic functions
      if (obj.__intrinsic === "Ref") {
        const name = obj.name as string;
        if (name.startsWith("AWS::")) {
          return `AWS.${this.pseudoParamName(name)}`;
        }
        const varName = this.safeVarName(name, importedSymbols);
        // Parameters need Ref() — bare variable would pass the Parameter object, not its value
        const isParam = ir.parameters.some((p) => p.name === name);
        if (isParam) {
          return `Ref(${varName})`;
        }
        return varName;
      }

      if (obj.__intrinsic === "GetAtt") {
        return this.attrExpr(obj.logicalId as string, obj.attribute as string, ir, importedSymbols);
      }

      if (obj.__intrinsic === "Sub") {
        return this.generateSubIntrinsic(obj.template as string, obj.variables as Record<string, unknown> | undefined, ir, importedSymbols);
      }

      if (obj.__intrinsic === "If") {
        const condition = obj.condition as string;
        const condRef = this.conditionVarRef(condition, ir, importedSymbols);
        const trueVal = this.generateValue(obj.valueIfTrue, ir, importedSymbols);
        const falseVal = this.generateValue(obj.valueIfFalse, ir, importedSymbols);
        return `If(${condRef}, ${trueVal}, ${falseVal})`;
      }

      if (obj.__intrinsic === "Equals") {
        const left = this.generateValue(obj.left, ir, importedSymbols);
        const right = this.generateValue(obj.right, ir, importedSymbols);
        return `Equals(${left}, ${right})`;
      }

      if (obj.__intrinsic === "And" || obj.__intrinsic === "Or") {
        const operands = (obj.conditions as unknown[]).map((c) => this.generateValue(c, ir, importedSymbols));
        return `${obj.__intrinsic}(${operands.join(", ")})`;
      }

      if (obj.__intrinsic === "Not") {
        return `Not(${this.generateValue(obj.condition, ir, importedSymbols)})`;
      }

      if (obj.__intrinsic === "ConditionRef") {
        return this.conditionVarRef(obj.name as string, ir, importedSymbols);
      }

      if (obj.__intrinsic === "Join") {
        const delimiter = JSON.stringify(obj.delimiter);
        const values = (obj.values as unknown[]).map((v) => this.generateValue(v, ir, importedSymbols));
        return `Join(${delimiter}, [${values.join(", ")}])`;
      }

      if (obj.__intrinsic === "Select") {
        const index = JSON.stringify(obj.index);
        if (Array.isArray(obj.values)) {
          const values = obj.values.map((v) => this.generateValue(v, ir, importedSymbols));
          return `Select(${index}, [${values.join(", ")}])`;
        }
        return `Select(${index}, ${this.generateValue(obj.source, ir, importedSymbols)})`;
      }

      if (obj.__intrinsic === "Split") {
        const delimiter = JSON.stringify(obj.delimiter);
        const source = this.generateValue(obj.source, ir, importedSymbols);
        return `Split(${delimiter}, ${source})`;
      }

      if (obj.__intrinsic === "Base64") {
        const value = this.generateValue(obj.value, ir, importedSymbols);
        return `Base64(${value})`;
      }

      if (obj.__intrinsic === "GetAZs") {
        const region = obj.region;
        if (region === undefined || region === "" || region === null) {
          return "GetAZs()";
        }
        return `GetAZs(${this.generateValue(region, ir, importedSymbols)})`;
      }

      // Regular object — quote keys that aren't valid JS identifiers
      const entries = Object.entries(obj).map(([key, val]) => {
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
        return `${safeKey}: ${this.generateValue(val, ir, importedSymbols)}`;
      });
      return `{ ${entries.join(", ")} }`;
    }

    return String(value);
  }

  /**
   * Generate Sub intrinsic as tagged template literal
   */
  private generateSubIntrinsic(template: string, variables: Record<string, unknown> | undefined, ir: TemplateIR, importedSymbols: Set<string>): string {
    const escapePart = (s: string) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

    // Parse ${...} interpolations from the Sub template
    const parts: string[] = [];
    const expressions: string[] = [];

    let currentPos = 0;
    const regex = /\$\{([^}]+)\}/g;
    let match;

    let literal = "";
    while ((match = regex.exec(template)) !== null) {
      const expr = match[1];
      // `${!Literal}` is CloudFormation's escape for a literal `${Literal}`;
      // it stays in the template text.
      if (expr.startsWith("!")) {
        literal += template.slice(currentPos, match.index + match[0].length);
        currentPos = match.index + match[0].length;
        continue;
      }
      parts.push(literal + template.slice(currentPos, match.index));
      literal = "";

      if (expr.startsWith("AWS::")) {
        expressions.push(`AWS.${this.pseudoParamName(expr)}`);
      } else if (variables && expr in variables) {
        expressions.push(this.generateValue(variables[expr], ir, importedSymbols));
      } else if (expr.includes(".")) {
        const dotIdx = expr.indexOf(".");
        expressions.push(this.attrExpr(expr.slice(0, dotIdx), expr.slice(dotIdx + 1), ir, importedSymbols));
      } else if (this.isDeclaredName(expr, ir)) {
        // A Declarable cannot be interpolated into Sub; Ref(<var>) serializes
        // as `${Name}`.
        expressions.push(`Ref(${this.safeVarName(expr, importedSymbols)})`);
      } else {
        expressions.push(`Ref(${JSON.stringify(expr)})`);
      }

      currentPos = match.index + match[0].length;
    }

    parts.push(literal + template.slice(currentPos));

    if (expressions.length === 0) {
      return `Sub\`${escapePart(template)}\``;
    }

    let result = "Sub`";
    for (let i = 0; i < parts.length; i++) {
      result += escapePart(parts[i]);
      if (i < expressions.length) {
        result += `\${${expressions[i]}}`;
      }
    }
    result += "`";

    return result;
  }

  /**
   * Convert AWS pseudo-parameter name to TypeScript
   */
  private pseudoParamName(awsName: string): string {
    // AWS::StackName -> StackName
    return awsName.replace("AWS::", "");
  }

  /**
   * Property names use spec-native casing (PascalCase for CloudFormation).
   */
  private toPropName(name: string): string {
    return name;
  }
}
