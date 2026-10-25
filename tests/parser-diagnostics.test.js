import { describe, it, expect } from "vitest";
import parser from "../parser.js";

describe("Parser syntax diagnostics", () => {
  it("keeps parseCode backward compatible", () => {
    const symbols = parser.parseCode(
      "function alpha() { return 1; }",
      "javascript"
    );
    expect(Array.isArray(symbols)).toBe(true);
    expect(symbols.some((item) => item.name === "alpha")).toBe(true);
  });

  it("reports no errors for valid JavaScript", () => {
    const result = parser.parseCodeDetailed(
      "function alpha() { return 1; }",
      "javascript"
    );
    expect(result.unsupportedLanguage).toBe(false);
    expect(result.hasErrors).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.symbols.some((item) => item.name === "alpha")).toBe(true);
  });

  it("reports no errors for valid Python", () => {
    const result = parser.parseCodeDetailed(
      "def alpha():\n    return 1\n",
      "python"
    );
    expect(result.hasErrors).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.symbols.some((item) => item.name === "alpha")).toBe(true);
  });

  it("detects malformed Python with diagnostic locations", () => {
    const result = parser.parseCodeDetailed(
      "def broken(:\n    return 1\n",
      "python"
    );
    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].startLine).toBeGreaterThan(0);
    expect(result.diagnostics[0].startColumn).toBeGreaterThan(0);
    expect(["ERROR", "MISSING_TOKEN", "SYNTAX_ERROR"])
      .toContain(result.diagnostics[0].type);
  });

  it("identifies unsupported languages", () => {
    const result = parser.parseCodeDetailed("anything", "unknown-language");
    expect(result.unsupportedLanguage).toBe(true);
    expect(result.symbols).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});
