import type { TemplateIR, ResourceIR, ParameterIR } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import { topoSort } from "@intentius/chant/codegen/topo-sort";
import { hasIntrinsicInValue, irUsesIntrinsic, collectDependencies } from "@intentius/chant/import/ir-utils";

/**
 * TypeScript code generator for CloudFormation templates
 */
export class CFGenerator implements TypeScriptGenerator {
  /**
   * Generate TypeScript files from intermediate representation
   */
  generate(ir: TemplateIR): GeneratedFile[] {
    const lines: string[] = [];

    // Generate imports
    lines.push(this.generateImports(ir));
    lines.push("");

    // Generate parameters
    for (const param of ir.parameters) {
      lines.push(this.generateParameter(param));
    }

    if (ir.parameters.length > 0) {
      lines.push("");
    }

    // Generate resources in dependency order
    const sortedResources = this.sortByDependencies(ir.resources);
    for (const resource of sortedResources) {
      lines.push(this.generateResource(resource, ir));
    }

    return [
      {
        path: "main.ts",
        content: lines.join("\n") + "\n",
      },
    ];
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
    const needsSub = irUsesIntrinsic(ir, "Sub");
    const needsRef = irUsesIntrinsic(ir, "Ref");
    const needsIf = irUsesIntrinsic(ir, "If");
    const needsJoin = irUsesIntrinsic(ir, "Join");

    if (needsSub) imports.add("Sub");
    if (needsRef) imports.add("Ref");
    if (needsIf) imports.add("If");
    if (needsJoin) imports.add("Join");

    // Check for AWS pseudo-parameters
    if (this.needsAWSPseudo(ir)) {
      imports.add("AWS");
    }

    // Collect service imports
    for (const resource of ir.resources) {
      const { service, resourceClass } = this.parseResourceType(resource.type);
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
   * Parse AWS resource type into service and class names
   */
  private parseResourceType(type: string): { service: string; resourceClass: string } {
    // AWS::S3::Bucket -> { service: "s3", resourceClass: "Bucket" }
    const parts = type.split("::");
    return {
      service: parts[1]?.toLowerCase() ?? "unknown",
      resourceClass: parts[2] ?? "Unknown",
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
    return topoSort(
      resources,
      (r) => r.logicalId,
      (r) => [...collectDependencies(r.properties, (obj) => {
        if (obj.__intrinsic === "Ref") {
          const name = obj.name as string;
          return name.startsWith("AWS::") ? null : name;
        }
        if (obj.__intrinsic === "GetAtt") {
          return obj.logicalId as string;
        }
        return null;
      })],
    );
  }

  /**
   * Generate a parameter declaration
   */
  private generateParameter(param: ParameterIR): string {
    const varName = this.toVariableName(param.name);
    return `export const ${varName} = new Parameter("${param.type}");`;
  }

  /**
   * Generate a resource declaration
   */
  private generateResource(resource: ResourceIR, ir: TemplateIR): string {
    const varName = this.toVariableName(resource.logicalId);
    const { resourceClass } = this.parseResourceType(resource.type);
    const propsStr = this.generateProps(resource.properties, ir);

    if (propsStr === "{}") {
      return `export const ${varName} = new ${resourceClass}();`;
    }

    return `export const ${varName} = new ${resourceClass}(${propsStr});`;
  }

  /**
   * Generate property object as TypeScript
   */
  private generateProps(props: Record<string, unknown>, ir: TemplateIR): string {
    if (Object.keys(props).length === 0) {
      return "{}";
    }

    const entries = Object.entries(props).map(([key, value]) => {
      const propName = this.toPropName(key);
      const valueStr = this.generateValue(value, ir);
      return `  ${propName}: ${valueStr}`;
    });

    return `{\n${entries.join(",\n")},\n}`;
  }

  /**
   * Generate a value as TypeScript
   */
  private generateValue(value: unknown, ir: TemplateIR): string {
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
      const items = value.map((item) => this.generateValue(item, ir));
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
        return this.toVariableName(name);
      }

      if (obj.__intrinsic === "GetAtt") {
        const logicalId = obj.logicalId as string;
        const attribute = obj.attribute as string;
        const varName = this.toVariableName(logicalId);
        const attrName = this.toPropName(attribute);
        return `${varName}.${attrName}`;
      }

      if (obj.__intrinsic === "Sub") {
        return this.generateSubIntrinsic(obj.template as string, ir);
      }

      if (obj.__intrinsic === "If") {
        const condition = obj.condition as string;
        const trueVal = this.generateValue(obj.valueIfTrue, ir);
        const falseVal = this.generateValue(obj.valueIfFalse, ir);
        return `If("${condition}", ${trueVal}, ${falseVal})`;
      }

      if (obj.__intrinsic === "Join") {
        const delimiter = JSON.stringify(obj.delimiter);
        const values = (obj.values as unknown[]).map((v) => this.generateValue(v, ir));
        return `Join(${delimiter}, [${values.join(", ")}])`;
      }

      // Regular object
      const entries = Object.entries(obj).map(([key, val]) => {
        return `${key}: ${this.generateValue(val, ir)}`;
      });
      return `{ ${entries.join(", ")} }`;
    }

    return String(value);
  }

  /**
   * Generate Sub intrinsic as tagged template literal
   */
  private generateSubIntrinsic(template: string, ir: TemplateIR): string {
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
      } else if (expr.includes(".")) {
        const [logicalId, attr] = expr.split(".");
        const varName = this.toVariableName(logicalId);
        const attrName = this.toPropName(attr);
        expressions.push(`${varName}.${attrName}`);
      } else {
        expressions.push(this.toVariableName(expr));
      }

      currentPos = match.index + match[0].length;
    }

    parts.push(template.slice(currentPos));

    if (expressions.length === 0) {
      return `Sub\`${template}\``;
    }

    let result = "Sub`";
    for (let i = 0; i < parts.length; i++) {
      result += parts[i];
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
   * Convert a logical name to a valid TypeScript variable name
   */
  private toVariableName(name: string): string {
    return name.charAt(0).toLowerCase() + name.slice(1);
  }

  /**
   * Convert a property name to camelCase
   */
  private toPropName(name: string): string {
    return name.charAt(0).toLowerCase() + name.slice(1);
  }
}
