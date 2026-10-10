import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { artTheme, FALLBACK_THEME, type ArtTheme } from "./theme";
import { loadColorways, normalizeKey, themeFor, type Colorway } from "./colorways";
import { getVersion } from "@tauri-apps/api/app";


interface MediaState {
  available: boolean;
  title: string;
  artist: string;
  album: string;
  position_ms: number;
  duration_ms: number;
  playing: boolean;
  volume: number;
}

const IDLE: MediaState = {
  available: false,
  title: "",
  artist: "",
  album: "",
  position_ms: 0,
  duration_ms: 0,
  playing: false,
  volume: 1,
};

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Position of a click/drag along an element's width, as 0..1. */
function fraction(e: React.PointerEvent | React.MouseEvent): number {
  return clamp((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth, 0, 1);
}

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 animate-spin">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Single-line text that drifts to its tail on a slow cycle when it overflows. */
function Marquee({ text, className = "" }: { text: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const b = box.current;
    const i = inner.current;
    if (b && i) setShift(Math.max(0, i.scrollWidth - b.clientWidth));
  }, [text]);

  return (
    <div ref={box} data-tauri-drag-region className={`overflow-hidden ${className}`}>
      <div
        ref={inner}
        data-tauri-drag-region
        className={shift ? "mq w-max whitespace-nowrap" : "whitespace-nowrap"}
        style={
          shift
            ? ({
                "--mq": `-${shift}px`,
                // The glide legs are 25% of the cycle each, so dividing by 7.5
                // lands near ~30px/s; the rest of the cycle is dwell time.
                "--mq-dur": `${Math.min(30, Math.max(10, shift / 7.5))}s`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </div>
    </div>
  );
}

export default function App() {
	const [state, setState] = useState<MediaState>(IDLE);
  const [version, setVersion] = useState("");
  // Artwork lives in its own event/state so fat base64 payloads never ride
  // along with lightweight position/metadata ticks.
  const [art, setArt] = useState<string | null>(null);
  const [theme, setTheme] = useState<ArtTheme>(FALLBACK_THEME);
  // Tray-controlled "Dynamic Theme" setting; backend persists it.
  const [enableTheme, setEnableTheme] = useState(true);
  // Hand-authored per-album colorways (embedded + user file).
  const [colorways, setColorways] = useState<Map<string, Colorway> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingTimer = useRef<number | null>(null);
  // Locally interpolated position so the bar moves smoothly between backend ticks.
  const [position, setPosition] = useState(0);
  // Volume is optimistic like play/pause: the slider follows the pointer, the
  // backend's echo is ignored mid-drag, and writes are throttled.
  const [volume, setVolume] = useState(1);
  const volAt = useRef(0);
  const volDragging = useRef(false);
  // Latest values for the global key handler, which must not re-register.
  const arrows = useRef({ position: 0, duration: 0, volume: 1 });
  const lastRef = useRef<{ at: number; position_ms: number; playing: boolean }>({
    at: Date.now(),
    position_ms: 0,
    playing: false,
  });

  useEffect(() => {
    // Startup sync: the backend may have emitted before this listener existed.
    invoke<{ state: MediaState; art: string | null } | null>("get_state").then((snap) => {
      if (snap) {
        lastRef.current = {
          at: Date.now(),
          position_ms: snap.state.position_ms,
          playing: snap.state.playing,
        };
        setPosition(snap.state.position_ms);
        setState(snap.state);
        setVolume(snap.state.volume);
        setArt(snap.art);
      }
    });
    const unArt = listen<string | null>("media-art", (e) => setArt(e.payload));
    const unThemePref = listen<boolean>("theme-preference", (e) =>
      setEnableTheme(e.payload),
    );
    invoke<boolean>("get_theme_pref").then(setEnableTheme).catch(() => {});
    loadColorways().then(setColorways).catch(() => {});
    const un = listen<MediaState>("media-state", (e) => {
      const s = e.payload;
      lastRef.current = { at: Date.now(), position_ms: s.position_ms, playing: s.playing };
      setPosition(s.position_ms);
      setState(s);
      if (!volDragging.current) {
        setVolume(s.volume);
      }
      setPending(false);
    });
    const unUpdates = listen<string | null>("check-updates", (e) => {
			if (e.payload) {
			setToast(`Downloading update v${e.payload} — the app will restart.`);
				setTimeout(() => setToast(null), 5000);
				return
    }
			setToast("You are on the latest version.");
      setTimeout(() => setToast(null), 3000);
		});
    const unUpdateErr = listen("check-updates-error", () => {
      setToast("Update check failed — try again later.");
      setTimeout(() => setToast(null), 5000);
		});
    getVersion().then((v) => setVersion(`v${v}`)).catch(() => {});

    const timer = setInterval(() => {
      const { at, position_ms, playing } = lastRef.current;
      if (playing) setPosition(position_ms + (Date.now() - at));
    }, 250);
    return () => {
      un.then((f) => f());
      unArt.then((f) => f());
      unThemePref.then((f) => f());
      unUpdateErr.then((f) => f());
      unUpdates.then((f) => f());
      clearInterval(timer);
    };
  }, []);

  // Re-grade the card whenever the artwork changes — unless the tray setting
  // turns the dynamic theme off, which pins the neutral look. Hand-authored
  // colorways (matched by artist|album) win over automatic extraction.
  useEffect(() => {
    if (!art || !enableTheme) {
      setTheme(FALLBACK_THEME);
      return;
    }
    const key = normalizeKey(state.artist, state.album);
    if (import.meta.env.DEV) console.log("[wmp:key]", key);
    const pending = colorways?.has(key)
      ? Promise.resolve(themeFor(colorways.get(key)!))
      : artTheme(art);
    let alive = true;
    pending.then((t) => {
      if (alive) setTheme(t);
    });
    return () => {
      alive = false;
    };
  }, [art, enableTheme, colorways, state.artist, state.album]);

  const send = (action: string) => {
    setPending(true);
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    // Safety net: never leave the spinner stuck if no state change comes back.
    pendingTimer.current = window.setTimeout(() => setPending(false), 2000);
    if (action === "play_pause") {
      // Optimistic toggle so the icon flips instantly; the next backend
      // state event reconciles it.
      setState((s) => ({ ...s, playing: !s.playing }));
      lastRef.current = {
        ...lastRef.current,
        at: Date.now(),
        playing: !lastRef.current.playing,
      };
    }
    invoke("control", { action });
  };
  const applyVolume = (v: number, force = false) => {
    setVolume(v);
    // Each write enumerates the app's audio sessions in the backend, so a drag
    // is throttled; the release commits the exact final value.
    const now = Date.now();
    if (!force && now - volAt.current < 80) return;
    volAt.current = now;
    invoke("control", { action: `volume:${v.toFixed(3)}` });
  };
  useEffect(() => {
    arrows.current = { position, duration: state.duration_ms, volume };
  });
  // Arrow keys drive the widget's two axes: horizontal = position, vertical =
  // volume (the mapping YouTube uses). Needs window focus, so: click the card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { position, duration, volume } = arrows.current;
      if (!duration) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const target = clamp(position + (e.key === "ArrowRight" ? 5000 : -5000), 0, duration);
        setPosition(target);
        lastRef.current = { ...lastRef.current, at: Date.now(), position_ms: target };
        invoke("control", { action: `seek:${Math.round(target)}` });
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        applyVolume(clamp(volume + (e.key === "ArrowUp" ? 0.05 : -0.05), 0, 1), true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const pct = state.duration_ms > 0 ? Math.min(100, (position / state.duration_ms) * 100) : 0;
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (state.duration_ms === 0) return;
    const target = fraction(e) * state.duration_ms;
    // Optimistic jump; the backend's timeline event reconciles.
    setPosition(target);
    lastRef.current = { ...lastRef.current, at: Date.now(), position_ms: target };
    invoke("control", { action: `seek:${Math.round(target)}` });
  };

  return (
    <div
      data-tauri-drag-region
      className="group relative flex h-screen w-screen items-stretch rounded-2xl border border-white/10 bg-neutral-900/80 text-white shadow-2xl backdrop-blur-xl transition-colors duration-500"
      style={
        theme.background
          ? { background: theme.background, color: theme.text }
          : undefined
      }
    >
      {/* Artwork */}
      <div data-tauri-drag-region className="m-2 h-[calc(100%-1rem)] shrink-0">
        {art ? (
          <img
            src={art}
            alt=""
            draggable={false}
            className="h-full w-24 rounded-xl object-cover"
          />
        ) : (
          <div
            className={`flex h-full w-24 items-center justify-center rounded-xl bg-white/5 ${
              state.available ? "animate-pulse" : ""
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-white/30">
              <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
            </svg>
          </div>
        )}
      </div>

      {/* Info + progress */}
      <div data-tauri-drag-region className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-2 pr-3">
        {state.available ? (
          <>
            <Marquee text={state.title || "Unknown track"} className="text-sm font-semibold" />
            <Marquee
              text={[state.artist, state.album].filter(Boolean).join(" · ") || "—"}
              className="text-xs opacity-75"
            />
            <div
              data-tauri-drag-region
              className="mt-1 flex items-center gap-2 text-[10px] tabular-nums"
              style={theme.accent ? { color: theme.accent } : undefined}
            >
              <span>{fmt(position)}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-white/80 transition-[width] duration-200"
                  style={{ width: `${pct}%`, background: theme.accent || undefined }}
                />
              </div>
              <span>{fmt(state.duration_ms)}</span>
            </div>
          </>
        ) : (
          <div data-tauri-drag-region className="text-xs opacity-60">
            No media playing — open Spotify, a browser tab, or any media app.
          </div>
        )}
      </div>

      {/* Hover controls — the overlay itself ignores pointer events so the
          card underneath stays draggable; only the buttons are clickable. */}
      {state.available && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-5 rounded-2xl bg-neutral-900/60 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <button
            onClick={() => send("prev")}
            className="pointer-events-auto -m-2 cursor-pointer rounded-full p-3.5 text-white/80 hover:bg-white/10 hover:text-white active:scale-95"
            title="Previous"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
            </svg>
          </button>
          <button
            onClick={() => send("play_pause")}
            className="pointer-events-auto -m-1 cursor-pointer rounded-full bg-white p-4 text-neutral-900 transition-transform hover:scale-105 active:scale-95"
            title="Play / Pause"
          >
            {pending ? <Spinner /> : <PlayIcon playing={state.playing} />}
          </button>
          <button
            onClick={() => send("next")}
            className="pointer-events-auto -m-2 cursor-pointer rounded-full p-3.5 text-white/80 hover:bg-white/10 hover:text-white active:scale-95"
            title="Next"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
              <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
            </svg>
          </button>
          {/* Volume — same track/fill language as the progress bar, plus a
              knob. Deliberately NOT on the seek bar's row: two adjacent
              horizontal sliders get mis-scrubbed, so volume sits at the top-left
              end instead, sharing the seek bar's 1rem left margin. It drives the
              media app's own audio sessions (system volume if it has none). */}
          <div className="pointer-events-auto absolute top-3 left-4 flex items-center gap-2" title="Volume">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current opacity-60">
              <path d="M5 9v6h3.5L13 19V5L8.5 9H5zm11.5 3a4.5 4.5 0 0 0-2-3.7v7.4a4.5 4.5 0 0 0 2-3.7z" />
            </svg>
            <div
              className="relative flex h-3 w-24 cursor-pointer items-center"
              onPointerDown={(e) => {
                volDragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                applyVolume(fraction(e), true);
              }}
              onPointerMove={(e) => volDragging.current && applyVolume(fraction(e))}
              onPointerUp={(e) => {
                volDragging.current = false;
                applyVolume(fraction(e), true);
              }}
            >
              <div className="h-1 w-full overflow-hidden rounded-full bg-white/25">
                <div
                  className="h-full rounded-full bg-white"
                  style={{ width: `${volume * 100}%`, background: theme.accent || undefined }}
                />
              </div>
              <div
                className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-white shadow"
                style={{ left: `${volume * 100}%` }}
              />
            </div>
          </div>
          {/* Seek bar — only lives in the hover overlay; h-3 wrapper is the
              hit area, the visible track is h-1. */}
          <div
            onClick={seek}
            className="pointer-events-auto absolute inset-x-4 bottom-3 flex h-3 cursor-pointer items-center"
          >
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/25">
              <div
                className="h-full rounded-full bg-white"
                style={{ width: `${pct}%`, background: theme.accent || undefined }}
              />
            </div>
          </div>
        </div>
			)}

      <div className="absolute top-2 right-3 text-[9px] tabular-nums opacity-75">
      	{version}
			</div>

      {toast && (
        <div className="absolute top-2 right-3 rounded-md bg-[#56565a] px-3 py-1 text-[10px] text-white/80">
          {toast}
        </div>
      )}
    </div>
  );
}
