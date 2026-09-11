// Color grading from artwork: extract a base color, derive a dark tinted card
// background and a WCAG-compliant accent. Plain math, no deps.

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

function averageColor(src: string): Promise<RGB> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			// ponytail: 16x16 average; swap for vibrant-bucket extraction if dark
			// covers start grading muddy gray/brown.
			const c = document.createElement("canvas");
			c.width = c.height = 16;
			const ctx = c.getContext("2d");
			if (!ctx) return reject(new Error("no 2d context"));
			ctx.drawImage(img, 0, 0, 16, 16);
			const d = ctx.getImageData(0, 0, 16, 16).data;
			let r = 0,
				g = 0,
				b = 0,
				n = 0;
			for (let i = 0; i < d.length; i += 4) {
				if (d[i + 3] < 128) continue;
				r += d[i];
				g += d[i + 1];
				b += d[i + 2];
				n++;
			}
			n > 0
				? resolve([r / n, g / n, b / n])
				: reject(new Error("empty artwork"));
		};
		img.onerror = () => reject(new Error("artwork load failed"));
		img.src = src;
	});
}

const NEUTRAL: RGB = [23, 23, 23]; // matches bg-neutral-900
const WHITE: RGB = [255, 255, 255];

export async function artTheme(art: string): Promise<ArtTheme> {
	const base = await averageColor(art).catch(() => null);
	if (!base) return FALLBACK_THEME;

	// Card: neutral-900 tinted with ~12% of the art color, darkened until white
	// text keeps >= 4.5:1 (cap L_bg at 1.05/4.5 - 0.05). ponytail: contrast is
	// computed against the opaque color; at 0.8 alpha over a light wallpaper the
	// real ratio drifts slightly — tighten maxBgL if that ever matters.
	let bg = mix(NEUTRAL, base, 0.12);
	const maxBgL = 1.05 / 4.5 - 0.05;
	for (let i = 0; i < 20 && luminance(bg) > maxBgL; i++) {
		bg = [bg[0] * 0.9, bg[1] * 0.9, bg[2] * 0.9];
	}

	// Accent: art color lightened toward white until it hits 4.5:1 on the card
	// (covers the 3:1 non-text minimum too); white if it never gets there.
	let accent = base;
	const bgL = luminance(bg);
	for (let i = 0; i < 12 && contrast(luminance(accent), bgL) < 4.5; i++) {
		accent = mix(accent, WHITE, 0.15);
	}
	if (contrast(luminance(accent), bgL) < 4.5) accent = WHITE;

	// 0.8 alpha matches the old bg-neutral-900/80 frosted look.
	const bgCss = `rgba(${bg.map(Math.round).join(" ")}, 0.85)`;
	return { background: bgCss, accent: css(accent) };
}
