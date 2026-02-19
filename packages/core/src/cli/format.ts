/**
 * ANSI color codes for terminal output
 */
const colors = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

/**
 * Check if colors should be used (respects NO_COLOR env var)
 */
function useColors(): boolean {
  return !process.env.NO_COLOR && process.stdout.isTTY !== false;
}

/**
 * Apply color if colors are enabled
 */
function color(text: string, colorCode: string): string {
  if (!useColors()) return text;
  return `${colorCode}${text}${colors.reset}`;
}

/**
 * Format an error with ANSI colors
 * Shows file:line:column in cyan, error in red
 */
export function formatError(error: {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  name?: string;
  hint?: string;
}): string {
  const parts: string[] = [];

  // Location prefix
  if (error.file) {
    let location = error.file;
    if (error.line !== undefined) {
      location += `:${error.line}`;
      if (error.column !== undefined) {
        location += `:${error.column}`;
      }
    }
    parts.push(color(location, colors.cyan));
    parts.push(" - ");
  }

  // Error type
  parts.push(color("error", colors.red));
  parts.push(": ");

  // Message
  parts.push(error.message);

  // Hint
  if (error.hint) {
    parts.push("\n  ");
    parts.push(color(error.hint, colors.gray));
  }

  return parts.join("");
}

/**
 * Format a warning with ANSI colors
 * Shows file:line:column in cyan, warning in yellow
 */
export function formatWarning(warning: {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  hint?: string;
}): string {
  const parts: string[] = [];

  // Location prefix
  if (warning.file) {
    let location = warning.file;
    if (warning.line !== undefined) {
      location += `:${warning.line}`;
      if (warning.column !== undefined) {
        location += `:${warning.column}`;
      }
    }
    parts.push(color(location, colors.cyan));
    parts.push(" - ");
  }

  // Warning type
  parts.push(color("warning", colors.yellow));
  parts.push(": ");

  // Message
  parts.push(warning.message);

  // Hint
  if (warning.hint) {
    parts.push("\n  ");
    parts.push(color(warning.hint, colors.gray));
  }

  return parts.join("");
}

/**
 * Format a success message in green
 */
export function formatSuccess(message: string): string {
  return color(message, colors.green);
}

/**
 * Format an info message in gray
 */
export function formatInfo(message: string): string {
  return color(message, colors.gray);
}

/**
 * Format a count/stat in bold
 */
export function formatBold(text: string): string {
  return color(text, colors.bold);
}
