import { watch } from "fs";
import { relative } from "path";

/**
 * Watch options
 */
export interface WatchOptions {
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number;
  /** File extensions to include (default: [".ts"]) */
  extensions?: string[];
  /** Directory names to ignore */
  ignoreDirs?: string[];
}

const DEFAULT_OPTIONS: Required<WatchOptions> = {
  debounceMs: 300,
  extensions: [".ts"],
  ignoreDirs: ["node_modules", ".chant"],
};

/**
 * Check if a file path should be watched
 */
export function shouldWatch(filePath: string, options: Required<WatchOptions>): boolean {
  // Ignore dotdirs
  const parts = filePath.split("/");
  for (const part of parts) {
    if (part.startsWith(".") && part.length > 1) return false;
    if (options.ignoreDirs.includes(part)) return false;
  }

  // Ignore test/spec files
  if (filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts")) return false;

  // Check extension
  return options.extensions.some((ext) => filePath.endsWith(ext));
}

/**
 * Format a timestamp as HH:MM:SS
 */
export function formatTimestamp(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Format changed files for display (relative paths, truncated if many)
 */
export function formatChangedFiles(files: string[], basePath: string, maxShow = 3): string {
  const relative_paths = files.map((f) => relative(basePath, f));

  if (relative_paths.length <= maxShow) {
    return relative_paths.join(", ");
  }

  const shown = relative_paths.slice(0, maxShow);
  return `${shown.join(", ")} (+${relative_paths.length - maxShow} more)`;
}

/**
 * Watch a directory for file changes with debouncing.
 * Returns a cleanup function to stop watching.
 */
export function watchDirectory(
  path: string,
  callback: (changedFiles: string[]) => void,
  options?: WatchOptions,
): () => void {
  const opts: Required<WatchOptions> = { ...DEFAULT_OPTIONS, ...options };
  let pendingFiles = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(path, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!shouldWatch(filename, opts)) return;

    // Collect the full path
    const fullPath = `${path}/${filename}`;
    pendingFiles.add(fullPath);

    // Reset the debounce timer
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pendingFiles];
      pendingFiles = new Set();
      timer = null;
      if (files.length > 0) {
        callback(files);
      }
    }, opts.debounceMs);
  });

  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
