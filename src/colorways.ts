// Hand-authored per-album colorways: an escape hatch for covers the automatic
// extraction can't feel right about. Embedded file ships with the app; a
// second file in the app data dir (read via the `read_user_colorways`
// command) carries personal/community additions without a reinstall.
// Colors always pass through themeFromColors, so unreadable entries can't
// ship — worst case they get nudged until they're readable.

import { invoke } from "@tauri-apps/api/core";
import embedded from "./colorways.json";
import { themeFromColors, type ArtTheme, type RGB } from "./theme";

export interface Colorway {
	bg: RGB;
	accent: RGB;
}

interface RawColorway {
	keys?: unknown;
	bg?: unknown;
	accent?: unknown;
}

// SMTC metadata is all we have for matching — normalized "artist|album".
export const normalizeKey = (artist: string, album: string) =>
	`${artist.trim().toLowerCase()}|${album.trim().toLowerCase()}`;

function hexToRgb(hex: string): RGB | undefined {
	const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
	if (!m) return undefined;
	const h = m[1];
	const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
	return [
		parseInt(full.slice(0, 2), 16),
		parseInt(full.slice(2, 4), 16),
		parseInt(full.slice(4, 6), 16),
	];
}

function addAll(map: Map<string, Colorway>, raw: unknown) {
	if (!Array.isArray(raw)) return;
	for (const e of raw as RawColorway[]) {
		const bg = hexToRgb(typeof e.bg === "string" ? e.bg : "");
		const accent = hexToRgb(typeof e.accent === "string" ? e.accent : "");
		if (!bg || !accent || !Array.isArray(e.keys)) continue;
		for (const k of e.keys) {
			if (typeof k === "string" && k.trim()) {
				map.set(k.trim().toLowerCase(), { bg, accent });
			}
		}
	}
}

export async function loadColorways(): Promise<Map<string, Colorway>> {
	const map = new Map<string, Colorway>();
	addAll(map, embedded);
	try {
		const local = await invoke<string | null>("read_user_colorways");
		if (local) addAll(map, JSON.parse(local));
	} catch {
		// no local file or bad JSON — embedded entries still apply
	}
	return map;
}

export function themeFor(cw: Colorway): ArtTheme {
	return themeFromColors(cw.bg, cw.accent);
}
