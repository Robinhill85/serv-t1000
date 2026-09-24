"use client";
// Background soundtrack (the demo video's track). Browsers only allow sound after a user gesture, so it starts on
// the first click/tap/key (or the intro's "Sound on"). Volume runs through Web Audio gain nodes (iOS ignores
// HTMLAudioElement.volume); two elements crossfade at the end of the track so the loop has no gap.
// Levels: louder during the intro, a quiet bed under the app. Muting is remembered per viewer (localStorage).

const SRC = "/audio/t1000-theme.mp3";
const KEY = "t1000.sound";
const XFADE = 3; // seconds
export const LEVEL = { intro: 0.55, app: 0.16 } as const;

let ctx: AudioContext | null = null;
const els: HTMLAudioElement[] = [];
const gains: GainNode[] = [];
let cur = 0;
let level: number = LEVEL.app;
let playing = false;
let crossing = false;
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}
let enabled = typeof window !== "undefined" ? readEnabled() : true;

function ramp(g: GainNode, to: number, secs: number) {
  if (!ctx) return;
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(g.gain.value, t);
  g.gain.linearRampToValueAtTime(to, t + secs);
}

function onTime(this: HTMLAudioElement) {
  const el = els[cur];
  if (this !== el || crossing || !el.duration || el.currentTime < el.duration - XFADE) return;
  // Crossfade into a fresh copy from the top.
  crossing = true;
  const prev = cur;
  cur = 1 - cur;
  els[cur].currentTime = 0;
  void els[cur].play().catch(() => {});
  ramp(gains[cur], level, XFADE);
  ramp(gains[prev], 0, XFADE);
  setTimeout(() => { els[prev].pause(); crossing = false; }, XFADE * 1000 + 150);
}

function ensure() {
  if (ctx) return;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx = new AC();
  for (let i = 0; i < 2; i++) {
    const el = new Audio(SRC);
    el.preload = "auto";
    const g = ctx.createGain();
    g.gain.value = 0;
    ctx.createMediaElementSource(el).connect(g).connect(ctx.destination);
    el.addEventListener("timeupdate", onTime);
    els.push(el);
    gains.push(g);
  }
  if (process.env.NODE_ENV !== "production") (window as unknown as { __sound: unknown }).__sound = { els, gains, ctx, cur: () => cur };
}

/** Starts (or restarts from the top) inside a user gesture. No-op when the viewer muted it. */
export function playSoundtrack(opts: { fromStart?: boolean; level?: number } = {}) {
  if (!enabled || typeof window === "undefined") return;
  ensure();
  void ctx!.resume();
  if (opts.level != null) level = opts.level;
  const el = els[cur];
  if (opts.fromStart) el.currentTime = 0;
  void el.play().then(() => { playing = true; ramp(gains[cur], level, 1.2); }).catch(() => {});
}

/** Eases the current level (e.g. intro -> app). */
export function setSoundtrackLevel(to: number, secs = 2) {
  level = to;
  if (ctx && playing) ramp(gains[cur], to, secs);
}

export function isSoundtrackPlaying() { return playing; }

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* storage unavailable */ }
  if (on) playSoundtrack();
  else if (ctx && playing) {
    ramp(gains[cur], 0, 0.4);
    setTimeout(() => { els.forEach((e) => e.pause()); playing = false; }, 450);
  }
  listeners.forEach((l) => l());
}

export const soundStore = {
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  get: () => enabled,
  getServer: () => true,
};

/** First click/tap/key anywhere starts the soundtrack (browsers block sound until then). */
export function installSoundtrack(introPlaying: () => boolean) {
  const start = () => {
    window.removeEventListener("pointerdown", start, true);
    window.removeEventListener("keydown", start, true);
    if (!playing) playSoundtrack({ level: introPlaying() ? LEVEL.intro : LEVEL.app });
  };
  window.addEventListener("pointerdown", start, true);
  window.addEventListener("keydown", start, true);
  return () => {
    window.removeEventListener("pointerdown", start, true);
    window.removeEventListener("keydown", start, true);
  };
}
