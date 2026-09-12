// Color grading from artwork, Panic's iTunes 11 style: edge-sampled background
// color, contrast-filtered dominant interior accents, WCAG-compliant output.
// Plain math, no deps.

export interface ArtTheme {
	background: string; // CSS color, "" = keep the default neutral card
	accent: string; // CSS color for progress fill / timestamps
}

export const FALLBACK_THEME: ArtTheme = { background: "", accent: "" };

type RGB = [number, number, number];

// WCAG 2.x relative luminance.
function luminance([r, g, b]: RGB): number {
	const f = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(l1: number, l2: number): number {
	const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
	return (hi + 0.05) / (lo + 0.05);
}

function mix(a: RGB, b: RGB, t: number): RGB {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t,
	];
}

const css = (c: RGB) => `rgb(${c.map(Math.round).join(" ")})`;

const SIZE = 32;

interface Buckets {
	edge: RGB; // dominant perimeter color
	interior: RGB[]; // inner colors, most frequent first
}

// Downsample to 32x32 (off-thread via createImageBitmap), then tally perimeter
// and interior pixels into 12-bit color buckets ((r>>4)<<8 | (g>>4)<<4 | b>>4),
// returning each group's average colors sorted by pixel count.
async function extract(src: string): Promise<Buckets> {
	const blob = await (await fetch(src)).blob();
	const bmp = await createImageBitmap(blob, {
		resizeWidth: SIZE,
		resizeHeight: SIZE,
	});
	const canvas = new OffscreenCanvas(SIZE, SIZE);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("no 2d context");
	ctx.drawImage(bmp, 0, 0);
	const d = ctx.getImageData(0, 0, SIZE, SIZE).data;

	interface Tally {
		n: number;
		r: number;
		g: number;
		b: number;
	}
	const edge = new Map<number, Tally>();
	const interior = new Map<number, Tally>();
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			const i = (y * SIZE + x) * 4;
			if (d[i + 3] < 128) continue;
			const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
			const m =
				x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1
					? edge
					: interior;
			const t = m.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
			t.n++;
			t.r += d[i];
			t.g += d[i + 1];
			t.b += d[i + 2];
			m.set(key, t);
		}
	}
	const avg = (t: Tally): RGB => [t.r / t.n, t.g / t.n, t.b / t.n];
	const sorted = (m: Map<number, Tally>) =>
		[...m.values()].sort((a, b) => b.n - a.n).map(avg);
	const edges = sorted(edge);
	if (edges.length === 0) throw new Error("empty artwork");
	return { edge: edges[0], interior: sorted(interior) };
}

const NEUTRAL: RGB = [23, 23, 23]; // matches bg-neutral-900
const WHITE: RGB = [255, 255, 255];

export async function artTheme(art: string): Promise<ArtTheme> {
	let buckets: Buckets;
	try {
		buckets = await extract(art);
	} catch {
		return FALLBACK_THEME;
	}

	// Card: neutral-900 blended 40% with the dominant *edge* color (enough for
	// the tint to read through the 0.85 alpha), then darkened until white text
	// keeps >= 4.5:1 (cap L_bg at 1.05/4.5 - 0.05). ponytail: contrast is
	// computed against the opaque color; at 0.85 alpha over a light wallpaper
	// the real ratio drifts slightly — tighten maxBgL if that ever matters.
	let bg = mix(NEUTRAL, buckets.edge, 0.4);
	const maxBgL = 1.05 / 4.5 - 0.05;
	// Scale down by the luminance overshoot (not a flat multiply) so the hue
	// survives darkening instead of collapsing to gray.
	const scale = Math.min(1, maxBgL / Math.max(luminance(bg), 1e-6));
	bg = [bg[0] * scale, bg[1] * scale, bg[2] * scale];
	for (let i = 0; i < 20 && luminance(bg) > maxBgL; i++) {
		bg = [bg[0] * 0.95, bg[1] * 0.95, bg[2] * 0.95];
	}
	const bgL = luminance(bg);

	// Accent: dominant interior color already passing 4.5:1 against the card
	// (covers the 3:1 non-text minimum too). Monochrome covers rarely pass;
	// lighten the dominant interior color as a fallback, then white.
	let accent: RGB | undefined = buckets.interior.find(
		(c) => contrast(luminance(c), bgL) >= 4.5,
	);
	if (!accent && buckets.interior.length > 0) {
		accent = buckets.interior[0];
		for (let i = 0; i < 12 && contrast(luminance(accent), bgL) < 4.5; i++) {
			accent = mix(accent, WHITE, 0.15);
		}
		if (contrast(luminance(accent), bgL) < 4.5) accent = WHITE;
	}

	// 0.85 alpha matches the frosted card look. Note the slash: with
	// space-separated channels, alpha must be `rgb(r g b / a)`.
	const bgCss = `rgb(${bg.map(Math.round).join(" ")} / 0.85)`;
	return { background: bgCss, accent: css(accent ?? WHITE) };
}
