/**
 * Redraws the card onto a canvas and puts the PNG on the clipboard.
 *
 * This duplicates the card's look in canvas code on purpose: a real
 * screenshot (WebView2 CapturePreview) needs COM plumbing and can't reach the
 * clipboard without a PNG→DIB conversion, and the print dialog we removed is
 * not a substitute. Keep these numbers in step with App.tsx's layout.
 *
 * The output is the card alone — no hover overlay — on a transparent margin,
 * so it can be pasted straight into a chat without a frame to crop off.
 */
import type { ArtTheme } from "./theme";

const W = 400; // the window's configured logical size
const H = 120;
const SCALE = 2; // retina crispness
const MARGIN = 24; // transparent breathing room around the card
const PAD = 8; // m-2
const ART_W = 96; // w-24
const RADIUS = 16; // rounded-2xl
const ART_RADIUS = 12; // rounded-xl
const FONT = "system-ui, -apple-system, sans-serif";

type Card = {
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  position: number;
  art: string;
  theme: ArtTheme;
};

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draws `text`, trimmed with an ellipsis if it doesn't fit `maxW`. */
function clipped(g: CanvasRenderingContext2D, text: string, maxW: number) {
  if (g.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

export async function copyCard(card: Card): Promise<void> {
  const { theme } = card;
  const canvas = document.createElement("canvas");
  canvas.width = (W + MARGIN * 2) * SCALE;
  canvas.height = (H + MARGIN * 2) * SCALE;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no 2d context");
  g.scale(SCALE, SCALE);
  // The margin stays transparent, so the card keeps its own silhouette wherever
  // it lands. The DOM's 10% white hairline is deliberately not drawn: on a
  // transparent edge it reads as a stray line rather than a border.
  g.translate(MARGIN, MARGIN);

  // The card itself: themed fill (already carries its own alpha).
  roundRect(g, 0, 0, W, H, RADIUS);
  g.fillStyle = theme.background || "rgb(23 23 23 / 0.8)";
  g.fill();

  const fg = theme.text || "rgb(255 255 255)";
  const accent = theme.accent || fg;

  // Artwork, object-cover into the same box the DOM uses.
  const artH = H - PAD * 2;
  const img = new Image();
  img.src = card.art;
  await img.decode();
  const cover = Math.max(ART_W / img.width, artH / img.height);
  const sw = ART_W / cover;
  const sh = artH / cover;
  g.save();
  roundRect(g, PAD, PAD, ART_W, artH, ART_RADIUS);
  g.clip();
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, PAD, PAD, ART_W, artH);
  g.restore();

  // Text column, mirroring the DOM's sizes and spacing.
  const bx = PAD + ART_W + 12;
  const textW = W - bx - 12;
  g.textBaseline = "alphabetic";
  g.fillStyle = fg;
  g.font = `600 14px ${FONT}`;
  g.fillText(clipped(g, card.title || "Unknown track", textW), bx, 45);
  g.globalAlpha = 0.75;
  g.font = `400 12px ${FONT}`;
  const sub = [card.artist, card.album].filter(Boolean).join(" · ") || "—";
  g.fillText(clipped(g, sub, textW), bx, 64);
  g.globalAlpha = 1;

  // Times + progress, in the accent like the widget's own bar.
  const barY = 78;
  g.font = `400 10px ${FONT}`;
  g.fillStyle = accent;
  const now = mmss(card.position);
  const end = mmss(card.duration_ms);
  g.fillText(now, bx, barY + 4);
  const endW = g.measureText(end).width;
  g.fillText(end, W - 12 - endW, barY + 4);
  const from = bx + g.measureText(now).width + 8;
  const to = W - 12 - endW - 8;
  const played = card.duration_ms ? Math.min(1, card.position / card.duration_ms) : 0;
  g.fillStyle = "rgba(255, 255, 255, 0.15)";
  roundRect(g, from, barY, to - from, 4, 2);
  g.fill();
  if (played > 0) {
    g.fillStyle = accent;
    roundRect(g, from, barY, (to - from) * played, 4, 2);
    g.fill();
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not encode the card");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
