"use client";
// Cold open: plays once per browser session, skippable from the first frame. The last beat (the pupil opening
// into the HUD) is done here in code, so it lands exactly on the live interface rather than a baked frame.
import { useCallback, useEffect, useRef, useState } from "react";

const SEEN_KEY = "t1000-intro-seen";

/** Fired once the intro is gone (or was never shown). Scripted demo runs wait for it. */
export const INTRO_DONE_EVENT = "t1000:intro-done";
function markDone() {
  (window as unknown as { __t1000IntroDone?: boolean }).__t1000IntroDone = true;
  window.dispatchEvent(new Event(INTRO_DONE_EVENT));
}
export function whenIntroDone(cb: () => void) {
  if ((window as unknown as { __t1000IntroDone?: boolean }).__t1000IntroDone) cb();
  else window.addEventListener(INTRO_DONE_EVENT, cb, { once: true });
}

type Stage = "hidden" | "playing" | "opening";

export function Intro({ src, poster }: { src: string; poster?: string }) {
  const [stage, setStage] = useState<Stage>("hidden");
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem(SEEN_KEY) === "1"; } catch { /* storage blocked: still play once */ }
    const demo = new URLSearchParams(window.location.search);
    if (seen || demo.get("intro") === "0") { markDone(); return; }
    const id = requestAnimationFrame(() => setStage("playing"));
    return () => cancelAnimationFrame(id);
  }, []);

  const open = useCallback(() => {
    try { sessionStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    setStage("opening");
    window.setTimeout(() => { setStage("hidden"); markDone(); }, 1100);
  }, []);

  // Autoplay can be refused (power saving, strict browser settings): open straight into the HUD instead of freezing.
  useEffect(() => {
    if (stage !== "playing") return;
    videoRef.current?.play().catch(() => open());
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
      <button className="intro-skip" onClick={open}>Skip</button>
    </div>
  );
}
