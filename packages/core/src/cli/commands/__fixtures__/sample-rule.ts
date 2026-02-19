export const sampleRule = {
  id: "TEST001",
  severity: "warning" as const,
  category: "style" as const,
  check() {
    return [];
  },
};

// Non-rule export — should be silently skipped by the loader
export const notARule = { foo: "bar" };
