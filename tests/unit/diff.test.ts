import { describe, it, expect } from "vitest";
import { computeDiff } from "../../src/core/diff.js";

describe("computeDiff", () => {
  it("reports no changes when content is identical", () => {
    const { hasChanges } = computeDiff("hello\n", "hello\n", "test.txt");
    expect(hasChanges).toBe(false);
  });

  it("reports changes and produces a patch", () => {
    const { hasChanges, patch } = computeDiff("hello\n", "world\n", "test.txt");
    expect(hasChanges).toBe(true);
    expect(patch).toContain("-hello");
    expect(patch).toContain("+world");
  });

  it("patch includes the file name", () => {
    const { patch } = computeDiff("a\n", "b\n", "my/file.ts");
    expect(patch).toContain("my/file.ts");
  });
});
