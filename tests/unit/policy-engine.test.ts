import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../../src/config/policy-engine.js";
import type { Policy } from "../../src/config/schema.js";

const defaultPolicy: Policy = {
  name: "test",
  allowed_tools: ["read_file", "write_file", "list_dir"],
  allowed_paths: [".", "src/**"],
  deny_patterns: ["**/.env", "**/secrets/**"],
  require_approval_for_writes: true,
};

describe("evaluatePolicy", () => {
  it("allows a permitted tool with a permitted path", () => {
    const result = evaluatePolicy(defaultPolicy, "read_file", { path: "src/index.ts" });
    expect(result.allowed).toBe(true);
  });

  it("denies a tool not in allowed_tools", () => {
    const result = evaluatePolicy(defaultPolicy, "shell_exec", { cmd: "ls" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowed_tools/);
  });

  it("denies a path that matches a deny_pattern", () => {
    const result = evaluatePolicy(defaultPolicy, "read_file", { path: "src/.env" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/deny_pattern/);
  });

  it("denies a path outside allowed_paths", () => {
    const result = evaluatePolicy(defaultPolicy, "read_file", { path: "/etc/passwd" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowed_paths/);
  });

  it("allows a tool with no path argument", () => {
    const result = evaluatePolicy(defaultPolicy, "list_dir", {});
    expect(result.allowed).toBe(true);
  });

  it("denies access to secrets directory", () => {
    const result = evaluatePolicy(defaultPolicy, "read_file", { path: "secrets/key.pem" });
    expect(result.allowed).toBe(false);
  });
});
