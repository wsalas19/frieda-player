import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface MediaState {
  available: boolean;
  title: string;
  artist: string;
  album: string;
  position_ms: number;
  duration_ms: number;
  playing: boolean;
  art: string | null;
}

const IDLE: MediaState = {
  available: false,
  title: "",
  artist: "",
  album: "",
  position_ms: 0,
  duration_ms: 0,
  playing: false,
  art: null,
};

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
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

export default function App() {
  const [state, setState] = useState<MediaState>(IDLE);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingTimer = useRef<number | null>(null);
  // Locally interpolated position so the bar moves smoothly between backend ticks.
  const [position, setPosition] = useState(0);
  const lastRef = useRef<{ at: number; position_ms: number; playing: boolean }>({
    at: Date.now(),
    position_ms: 0,
    playing: false,
  });

  useEffect(() => {
    const un = listen<MediaState>("media-state", (e) => {
      const s = e.payload;
      lastRef.current = { at: Date.now(), position_ms: s.position_ms, playing: s.playing };
      setPosition(s.position_ms);
      setState(s);
      setPending(false);
    });
    const unUpdates = listen("check-updates", () => {
      setToast("You are on the latest version. (0.1.0)");
      setTimeout(() => setToast(null), 3000);
    });
    const timer = setInterval(() => {
      const { at, position_ms, playing } = lastRef.current;
      if (playing) setPosition(position_ms + (Date.now() - at));
    }, 250);
    return () => {
      un.then((f) => f());
      unUpdates.then((f) => f());
      clearInterval(timer);
    };
  }, []);

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
  const pct = state.duration_ms > 0 ? Math.min(100, (position / state.duration_ms) * 100) : 0;

  return (
    <div
      data-tauri-drag-region
      className="group relative flex h-screen w-screen items-stretch rounded-2xl border border-white/10 bg-neutral-900/80 text-white shadow-2xl backdrop-blur-xl"
    >
      {/* Artwork */}
      <div data-tauri-drag-region className="m-2 h-[calc(100%-1rem)] shrink-0">
        {state.art ? (
          <img
            src={state.art}
            alt=""
            draggable={false}
            className="h-full w-24 rounded-xl object-cover"
          />
        ) : (
          <div className="flex h-full w-24 items-center justify-center rounded-xl bg-white/5">
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
            <div data-tauri-drag-region className="truncate text-sm font-semibold">
              {state.title || "Unknown track"}
            </div>
            <div data-tauri-drag-region className="truncate text-xs text-white/60">
              {[state.artist, state.album].filter(Boolean).join(" · ") || "—"}
            </div>
            <div data-tauri-drag-region className="mt-1 flex items-center gap-2 text-[10px] tabular-nums text-white/50">
              <span>{fmt(position)}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-white/80 transition-[width] duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span>{fmt(state.duration_ms)}</span>
            </div>
          </>
        ) : (
          <div data-tauri-drag-region className="text-xs text-white/40">
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
        </div>
      )}

      {toast && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-white/10 px-3 py-1 text-[10px] text-white/80">
          {toast}
        </div>
      )}
    </div>
  );
}
