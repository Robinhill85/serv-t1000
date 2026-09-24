# T1000 demo video: X cut (v4: final, 1.5× pace, 60s)

**Where it lives:** the X submission post, which tags @openservai. The tweet text carries the explanation and links, and the video carries the visuals.

**Format rules (X)**
- Autoplay is **muted** in the feed. Burned-in captions must tell the whole story without sound.
- Voiceover is optional, for viewers who turn sound on (judges likely will).
- Hook in the first 3 seconds: the intro's rising liquid metal does this.
- The final is 60.3s. Everything is cut on the 1× timeline below, then played at 1.5× (Robin's pick); the voice is time-stretched with its pitch kept.
- Build: `node scripts/build-demo.cjs --pace 1.5 --music assets/music/music-a-dark-industrial.m4a --out assets/cut/t1000-demo-final.mp4`.
- Music: track A (Higgsfield Sonilo, dark industrial). It leads the intro, ramps to a bed about 15 dB under the voice, and dips further on every spoken line. 1920×1080 H.264 + AAC.

**Assembly**
- Prepend the intro file.
- Record the app with `?intro=0` at 1280×720, browser scaled 1.5× (1080p output, everything 1.5× larger), typing the answers as free text.
- Speed up SERV's thinking time.
- Captions are big, short labels, 2–5 words each, in the HUD font.

| Time | Picture | Caption (always) | Voiceover (optional) |
|---|---|---|---|
| 0:00–0:10 | Intro: the blob rises, the eyes ignite | **Your idle stablecoins.** | "Your stablecoins are sitting idle." |
| 0:10–0:16 | The camera dives through the pupil into the HUD | **T1000 decides where they live.** | "T1000 decides where they should live." |
| 0:16–0:26 | Wallet scan, then typing "all is fine" and "half a year" | **Tell it in your own words**, then **Jev by TypeSafe classifies it · instantly** (on the "Got it: 3–12 months" read-back) | "Tell it what you want, in your own words." |
| 0:26–0:40 | HUD sweep: live data, Stock Tokens struck through | **Live scan · 3 chains · Jev scores** / **Stock tokens blocked: UK rules** | "It scans live markets across three chains, and knows what you're not allowed to touch." |
| 0:40–0:52 | "POSSIBLE ALLOCATION:" cursor, then the SHADOW AGENT CORRECTION stamp | **SERV reasons · Shadow Agent checks** | "SERV Reasoning drafts the split. A shadow agent checks it before any money moves." |
| 0:52–1:04 | Approve, then the vaults fill; the step list turns green (plus an optional 3s live proof with tx links) | **AgentKit executes · 6 txs · 3 chains** | "Then the agent executes, onchain." |
| 1:04–1:12 | Vision returns in GUARD MODE; the countdown ticks; watch list all OK | **It keeps watching** | "And it doesn't stop there. It keeps watching." |
| 1:12–1:24 | "Stress test: ETH +70%" → DRIFT alert, then the SERV proposal gets VERIFIED, then the ETH vault drains back into the mass | **Drift → SERV rebalances** / **SCENARIO · what-if only** | "When ether runs past your plan, Serve proposes the trim, and the shadow agent checks it again." |
| 1:24–1:30 | End card over the vault shot | **T1000 · reasoning on SERV** | "T1000. Liquid capital." |

**Voiceover text (v3, as sent to TTS):** it spells "Serve" and "ether" for pronunciation. The captions keep SERV and ETH.

**Notes**
- No film footage, no actor-like voice, no film references.
- The live proof clip is a real $150 run from the operator wallet (passcode). The simulation stays the main flow.
