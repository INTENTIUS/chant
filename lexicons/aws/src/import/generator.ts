import { createRequire } from "module";
import type { TemplateIR, ResourceIR, ParameterIR } from "@intentius/chant/import/parser";
const require = createRequire(import.meta.url);
import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import { topoSort } from "@intentius/chant/codegen/topo-sort";
import { hasIntrinsicInValue, irUsesIntrinsic, collectDependencies } from "@intentius/chant/import/ir-utils";
import { join } from "path";

/**
 * TypeScript code generator for CloudFormation templates
 */
export class CFGenerator implements TypeScriptGenerator {
  private typeToClass: Map<string, string>;
  private allClassNames: Set<string>;

  constructor() {
    // Build reverse lookup from dist/meta.json: resourceType → className
    const metaPath = join(import.meta.dir, "../../dist/meta.json");
    const meta: Record<string, { resourceType: string; kind: string }> =
      require(metaPath);
    this.typeToClass = new Map();
    this.allClassNames = new Set();
    for (const [className, entry] of Object.entries(meta)) {
      if (entry.kind === "resource" && !className.includes("_")) {
        this.typeToClass.set(entry.resourceType, className);
        this.allClassNames.add(className);
      }
    }
  }

  /**
   * Generate TypeScript files from intermediate representation
   */
  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];

    // Collect the set of imported class names so we can detect variable name conflicts
    const importedSymbols = this.collectImportedSymbols(ir);

    // Generate imports
    lines.push(this.generateImports(ir));
    lines.push("");

    // Generate parameters
    for (const param of ir.parameters) {
      lines.push(this.generateParameter(param, importedSymbols));
    }

    if (ir.parameters.length > 0) {
      lines.push("");
    }

    // Generate resources in dependency order
    const sortedResources = this.sortByDependencies(ir.resources);
    for (const resource of sortedResources) {
      lines.push(this.generateResource(resource, ir, importedSymbols));
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
    const intrinsics = ["Sub", "Ref", "If", "Join", "Select", "Split", "Base64", "GetAZs", "GetAtt"] as const;
    for (const name of intrinsics) {
      if (irUsesIntrinsic(ir, name)) symbols.add(name);
    }
    if (this.needsAWSPseudo(ir)) symbols.add("AWS");
    for (const resource of ir.resources) {
      const parsed = this.parseResourceType(resource.type);
      if (parsed) symbols.add(parsed.resourceClass);
    }
    return symbols;
  }

  /**
   * Resolve a logical ID to a safe variable name, suffixing with _ if it conflicts with an imported symbol
   */
  private safeVarName(name: string, importedSymbols: Set<string>): string {
    return importedSymbols.has(name) ? name + "_" : name;
  }

  /**
   * Generate import statements
   */
  private generateImports(ir: TemplateIR): string {
    const imports: Set<string> = new Set();
    const serviceImports: Map<string, Set<string>> = new Map();

    // Collect what we need to import
    const needsParameter = ir.parameters.length > 0;
    if (needsParameter) {
      imports.add("Parameter");
    }

    // Check for intrinsics
    const intrinsics = ["Sub", "Ref", "If", "Join", "Select", "Split", "Base64", "GetAZs", "GetAtt"] as const;
    for (const name of intrinsics) {
      if (irUsesIntrinsic(ir, name)) imports.add(name);
    }

    // Check for AWS pseudo-parameters
    if (this.needsAWSPseudo(ir)) {
      imports.add("AWS");
    }

    // Collect service imports (skip unknown resource types)
    for (const resource of ir.resources) {
      const parsed = this.parseResourceType(resource.type);
      if (!parsed) continue;
      const { service, resourceClass } = parsed;
      if (!serviceImports.has(service)) {
        serviceImports.set(service, new Set());
      }
      serviceImports.get(service)!.add(resourceClass);
    }

    // Build import lines
    const importLines: string[] = [];

    // Merge service resource imports into the core imports set
    for (const [_service, resources] of serviceImports) {
      for (const r of resources) {
        imports.add(r);
      }
    }

    // All imports come from the flat @intentius/chant-lexicon-aws package
    const allImports = [...imports];
    if (allImports.length > 0) {
      importLines.push(`import { ${allImports.join(", ")} } from "@intentius/chant-lexicon-aws";`);
    }

    return importLines.join("\n");
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
    for (const resource of ir.resources) {
      if (this.hasAWSPseudo(resource.properties)) {
        return true;
      }
    }
    return false;
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
        const deps = collectDependencies(r.properties, (obj) => {
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
   * Generate a parameter declaration
   */
  private generateParameter(param: ParameterIR, importedSymbols: Set<string>): string {
    const varName = this.safeVarName(param.name, importedSymbols);
    const opts: string[] = [];
    if (param.description) opts.push(`description: ${JSON.stringify(param.description)}`);
    if (param.defaultValue !== undefined) opts.push(`defaultValue: ${JSON.stringify(param.defaultValue)}`);
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
    const { resourceClass } = parsed;
    const propsStr = this.generateProps(resource.properties, ir, importedSymbols);

    if (propsStr === "{}") {
      return `export const ${varName} = new ${resourceClass}();`;
    }

    return `export const ${varName} = new ${resourceClass}(${propsStr});`;
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
        const logicalId = obj.logicalId as string;
        const attribute = obj.attribute as string;
        const varName = this.safeVarName(logicalId, importedSymbols);
        if (attribute.includes(".")) {
          return `GetAtt(${varName}, "${attribute}")`;
        }
        const attrName = this.toPropName(attribute);
        return `${varName}.${attrName}`;
      }

      if (obj.__intrinsic === "Sub") {
        return this.generateSubIntrinsic(obj.template as string, obj.variables as Record<string, unknown> | undefined, ir, importedSymbols);
      }

      if (obj.__intrinsic === "If") {
        const condition = obj.condition as string;
        const trueVal = this.generateValue(obj.valueIfTrue, ir, importedSymbols);
        const falseVal = this.generateValue(obj.valueIfFalse, ir, importedSymbols);
        return `If("${condition}", ${trueVal}, ${falseVal})`;
      }

      if (obj.__intrinsic === "Join") {
        const delimiter = JSON.stringify(obj.delimiter);
        const values = (obj.values as unknown[]).map((v) => this.generateValue(v, ir, importedSymbols));
        return `Join(${delimiter}, [${values.join(", ")}])`;
      }

      if (obj.__intrinsic === "Select") {
        const index = obj.index as number;
        const values = (obj.values as unknown[]).map((v) => this.generateValue(v, ir, importedSymbols));
        return `Select(${index}, [${values.join(", ")}])`;
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

    while ((match = regex.exec(template)) !== null) {
      parts.push(template.slice(currentPos, match.index));

      const expr = match[1];
      if (expr.startsWith("AWS::")) {
        expressions.push(`AWS.${this.pseudoParamName(expr)}`);
      } else if (variables && expr in variables) {
        expressions.push(this.generateValue(variables[expr], ir, importedSymbols));
      } else if (expr.includes(".")) {
        const dotIdx = expr.indexOf(".");
        const logicalId = expr.slice(0, dotIdx);
        const attr = expr.slice(dotIdx + 1);
        const varName = this.safeVarName(logicalId, importedSymbols);
        if (attr.includes(".")) {
          expressions.push(`GetAtt(${varName}, "${attr}")`);
        } else {
          const attrName = this.toPropName(attr);
          expressions.push(`${varName}.${attrName}`);
        }
      } else {
        expressions.push(this.safeVarName(expr, importedSymbols));
      }

      currentPos = match.index + match[0].length;
    }

    parts.push(template.slice(currentPos));

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
