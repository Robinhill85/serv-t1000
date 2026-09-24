"use client";
// Cold open: plays once per browser session (and again on Restart), skippable from the first frame. The last beat (the pupil opening
// into the HUD) is done here in code, so it lands exactly on the live interface rather than a baked frame.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isSoundtrackPlaying, LEVEL, playSoundtrack, setSoundtrackLevel, soundStore } from "@/lib/soundtrack";

const SEEN_KEY = "t1000-intro-seen";

/** Fired once the intro is gone (or was never shown). Scripted demo runs wait for it. */
export const INTRO_DONE_EVENT = "t1000:intro-done";
function markDone() {
  (window as unknown as { __t1000IntroDone?: boolean }).__t1000IntroDone = true;
  window.dispatchEvent(new Event(INTRO_DONE_EVENT));
}
const REPLAY_EVENT = "t1000:intro-replay";
/** Restart from the top: the intro plays again and whenIntroDone waits for it (unless the URL has intro=0). */
export function replayIntro() {
  try { sessionStorage.removeItem(SEEN_KEY); } catch { /* ignore */ }
  if (new URLSearchParams(window.location.search).get("intro") === "0") { markDone(); return; }
  (window as unknown as { __t1000IntroDone?: boolean }).__t1000IntroDone = false;
  window.dispatchEvent(new Event(REPLAY_EVENT));
  // Restart is a click, so the soundtrack may restart with the cold open.
  if (isSoundtrackPlaying()) playSoundtrack({ fromStart: true, level: LEVEL.intro });
}
export function whenIntroDone(cb: () => void) {
  if ((window as unknown as { __t1000IntroDone?: boolean }).__t1000IntroDone) cb();
  else window.addEventListener(INTRO_DONE_EVENT, cb, { once: true });
}

type Stage = "hidden" | "playing" | "opening";

export function Intro({ src, poster }: { src: string; poster?: string }) {
  const [stage, setStage] = useState<Stage>("hidden");
  const videoRef = useRef<HTMLVideoElement>(null);
  const soundOn = useSyncExternalStore(soundStore.subscribe, soundStore.get, soundStore.getServer);
  const [withSound, setWithSound] = useState(false);
  /** The cold open with its soundtrack: restart the video and the track together. */
  const playWithSound = () => {
    const v = videoRef.current;
    if (v) { v.currentTime = 0; void v.play().catch(() => {}); }
    playSoundtrack({ fromStart: true, level: LEVEL.intro });
    setWithSound(true);
  };

  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem(SEEN_KEY) === "1"; } catch { /* storage blocked: still play once */ }
    const demo = new URLSearchParams(window.location.search);
    if (seen || demo.get("intro") === "0") { markDone(); return; }
    const id = requestAnimationFrame(() => setStage("playing"));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const replay = () => {
      const v = videoRef.current;
      if (v) v.currentTime = 0;
      setStage("playing");
    };
    window.addEventListener(REPLAY_EVENT, replay);
    return () => window.removeEventListener(REPLAY_EVENT, replay);
  }, []);

  const open = useCallback(() => {
    try { sessionStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    setStage("opening");
    setSoundtrackLevel(LEVEL.app, 2.5); // the soundtrack settles into a quiet bed under the app
    window.setTimeout(() => { setStage("hidden"); markDone(); }, 1100);
  }, []);

  // Autoplay can be refused (power saving, strict browser settings): open straight into the HUD instead of freezing.
  useEffect(() => {
    if (stage !== "playing") return;
    const v = videoRef.current;
    if (v) v.currentTime = 0;
    v?.play().catch(() => open());
  }, [stage, open]);

  if (stage === "hidden") return null;
  return (
    <div className={`intro ${stage === "opening" ? "is-opening" : ""}`} role="dialog" aria-label="Intro">
      <video
        ref={videoRef}
        className="intro-video"
        src={src}
        poster={poster}
        autoPlay
        muted
        playsInline
        onEnded={open}
        onError={open}
      />
      <div className="intro-iris" aria-hidden />
      <div className="intro-actions">
        {soundOn && !withSound && <button className="intro-skip" onClick={playWithSound}>Sound on</button>}
        <button className="intro-skip" onClick={open}>Skip</button>
      </div>
    </div>
  );
}
