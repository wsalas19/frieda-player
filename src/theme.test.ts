import { describe, expect, it } from "vitest";
import { themeFromColors, type RGB } from "./theme";

const parse = (css: string): RGB => {
  const m = /rgb\((\d+) (\d+) (\d+)/.exec(css);
  if (!m) throw new Error(`unparseable color: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

// WCAG relative luminance / contrast, mirrored here so the test does not depend
// on the implementation's private helpers.
const luminance = ([r, g, b]: RGB): number => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const contrast = (a: RGB, b: RGB): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("themeFromColors", () => {
  it("keeps the text readable on the card (>= 4.4:1)", () => {
    const samples: [RGB, RGB][] = [
      [
        [255, 255, 255],
        [0, 0, 0],
      ],
      [
        [0, 0, 0],
        [255, 255, 255],
      ],
      [
        [128, 128, 128],
        [128, 128, 128],
      ],
      [
        [200, 40, 40],
        [40, 40, 200],
      ],
      [
        [12, 12, 14],
        [12, 12, 14],
      ],
      [
        [240, 230, 210],
        [30, 90, 160],
      ],
    ];
    for (const [bg, accent] of samples) {
      const theme = themeFromColors(bg, accent);
      expect(contrast(parse(theme.text), parse(theme.background))).toBeGreaterThanOrEqual(4.4);
    }
  });

  it("returns a translucent card background and opaque text/accent", () => {
    const theme = themeFromColors([100, 100, 100], [50, 50, 50]);
    expect(theme.background).toMatch(/\/ 0\.85\)$/);
    expect(theme.text).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
    expect(theme.accent).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
  });
});
