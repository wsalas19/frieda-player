// Card geometry shared by the live widget (App.tsx, which lays it out with
// Tailwind classes) and the clipboard renderer (share.ts, which draws it by
// hand). Keep App.tsx's classes in step with these numbers — this file is the
// single source of truth for share.ts.
export const CARD = {
  W: 400, // window's configured logical width
  H: 120, // window's configured logical height
  PAD: 8, // m-2
  ART_W: 96, // w-24
  RADIUS: 16, // rounded-2xl
  ART_RADIUS: 12, // rounded-xl
  MARGIN: 24, // transparent breathing room in the copied PNG
  SCALE: 2, // retina crispness
} as const;

export const FONT = "system-ui, -apple-system, sans-serif";
