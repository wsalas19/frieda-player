import { describe, expect, it } from "vitest";
import { normalizeKey } from "./colorways";

describe("normalizeKey", () => {
  it("lowercases and trims artist and album", () => {
    expect(normalizeKey("  Radiohead ", " In Rainbows ")).toBe("radiohead|in rainbows");
  });

  it("preserves the pipe separator for empty fields", () => {
    expect(normalizeKey("", "")).toBe("|");
    expect(normalizeKey("Artist", "")).toBe("artist|");
  });
});
