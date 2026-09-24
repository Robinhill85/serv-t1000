// Assembles the X demo cut: intro -> (pupil circle-open) -> take, with SERV waits sped up -> end card.
// Captions are rendered as PNGs in a browser (this ffmpeg has no drawtext) and overlaid; VO lines are placed on beats.
// Usage: PLAYWRIGHT=<playwright package> node scripts/build-demo.cjs [--music <file>] [--pace 1.5] [--out <file>]
// --pace speeds the whole cut (Robin's pick: 1.5x). Voice is time-stretched with pitch kept; music plays at its own tempo.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const ROOT = path.resolve(__dirname, "..");
const A = (...p) => path.join(ROOT, "assets", ...p);
const TAKE = A("takes", "take3", "take3.mp4");
const INTRO = path.join(ROOT, "public", "intro", "t1000-intro.mp4");
const VO = A("vo", "arthur-vo-v3.mp3");
const VO_LINES = [
  ...JSON.parse(fs.readFileSync(A("vo", "arthur-vo-v3.lines.json"), "utf8")).lines.map((l) => ({ ...l, file: VO })),
  // Added after v1 (Robin): Arthur naming Jev on the classification beat. Same voice, separate file.
  { beat: "jev", file: A("vo", "arthur-jev-line.mp3"), start: 0, end: 5.04, text: "Jev, by TypeSafe, classifies each answer instantly." },
];
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const MUSIC = opt("--music");
const PACE = +(opt("--pace") || 1);
const OUT = opt("--out") || A("cut", "t1000-demo-rough.mp4");
const WORK = A("cut", "work");
fs.mkdirSync(WORK, { recursive: true });

const ff = (args) => {
  if (process.env.BUILD_DEBUG) fs.writeFileSync(path.join(WORK, "last-ffmpeg.json"), JSON.stringify(args, null, 1));
  return execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
};
const dur = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim();

// Take 3 source ranges (seconds) and playback speed. The two SERV waits run 5x; everything the viewer reads runs 1x.
const SEGMENTS = [
  { from: 0.8, to: 3.9, speed: 1 }, //    greeting, scan wallet
  { from: 3.9, to: 17.9, speed: 1.3 }, //  answers in plain words
  { from: 17.9, to: 26.5, speed: 1 }, //  HUD sweep, stocks blocked, candidate list
  { from: 26.5, to: 42.0, speed: 5 }, //  Shadow Agent verifying
  { from: 42.0, to: 46.9, speed: 1 }, //  verified, plan in chat
  { from: 46.9, to: 53.4, speed: 1 }, //  simulate: vaults fill, hand-off to Guard
  { from: 53.4, to: 59.4, speed: 1.2 }, // Guard watching
  { from: 59.4, to: 70.0, speed: 1 }, //  stress test, DRIFT, ask SERV, draft
  { from: 70.0, to: 81.0, speed: 5 }, //  Shadow Agent verifying the moves
  { from: 81.0, to: 96.7, speed: 1 }, //  proposal, simulate moves, reverse flow, all clear
];
// Live proof (first live run, 24 Sep), cut in after the simulated deploy and before the end card.
// Robin's own screen recording (1988x1080): 6px white top border cropped, letterboxed to 1920x1080, the Next.js
// dev badge (bottom-left) covered with the scene's near-black (delogo smeared it red).
const ROBIN_LIVE = "/Users/robin/Downloads/take1.mp4";
const PROOF = A("takes", "proof");
const INSERTS = [
  {
    afterSeg: 5,
    clips: [
      { src: ROBIN_LIVE, from: 61.9, to: 66.4, speed: 1, vf: "crop=1988:1074:0:6,scale=1920:-2,pad=1920:1080:0:(oh-ih)/2,drawbox=x=0:y=984:w=78:h=76:color=0x0d0b0b@1:t=fill" },
      { still: path.join(PROOF, "explorer.png"), dur: 3.0 },
    ],
    captions: [{ t: [0.1, 4.4], text: "Live on mainnet · $105 into the IXS vault" }, { t: [4.6, 7.4], text: "Real tx on Avalanche · success" }],
  },
  {
    afterSeg: 9,
    clips: [{ src: path.join(PROOF, "guard.mp4"), from: 0.3, to: 4.2, speed: 1 }],
    captions: [{ t: [0.1, 3.8], text: "Live now · $150 across 3 chains · onchain" }],
  },
];
const clipLen = (c) => (c.still ? c.dur : (c.to - c.from) / c.speed); // on the 1x timeline

const XFADE = 0.9 / PACE; // pupil opening into the HUD
const END_CARD = PACE > 1 ? 3.8 : 4.8;

// Captions and VO starts are written on the 1x timeline and divided by PACE.
const CAPTIONS = [
  { t: [0.8, 7.6], text: "Your idle stablecoins." },
  { t: [8.4, 15.0], text: "T1000 decides where they live." },
  { t: [18.8, 22.7], text: "Tell it in your own words" },
  { t: [22.8, 29.0], text: "Jev by TypeSafe classifies it · instantly" },
  { t: [29.3, 34.0], text: "Live scan · 3 chains · Jev scores" },
  { t: [34.0, 37.5], text: "Stock tokens blocked: UK rules" },
  { t: [37.7, 45.5], text: "SERV reasons · Shadow Agent checks" },
  { t: [45.8, 52.0], text: "AgentKit · 6 txs · 3 chains" },
  { t: [52.3, 57.0], text: "Then it keeps watching" },
  { t: [57.3, 63.0], text: "What-if: ETH +70% → drift" },
  { t: [63.1, 74.5], text: "SERV rebalances · Shadow Agent checks" },
  { t: [74.7, 79.6], text: "Trim ETH · same chain" },
  { t: [79.7, 85.5], text: "Back to plan: 70 / 20 / 10" },
];
// Start of each VO line (by beat); "end" is placed on the end card instead.
const VO_AT = { idle: 1.5, decides: 9.5, "own-words": 19.6, jev: 23.0, scan: 30.0, serv: 36.6, execute: 46.4, watch: 52.8, rebalance: 61.0, end: 86.6 };

async function renderStills(bodyEnd) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const font = `<link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet">`;
  const capCss = `html,body{margin:0;width:1920px;height:1080px;background:transparent}
    .cap{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);font-family:'VT323',monospace;font-size:70px;line-height:1;
    letter-spacing:.04em;text-transform:uppercase;color:#fff3ee;background:rgba(14,0,0,.8);padding:12px 30px 8px;border-left:7px solid #ff3b1f;
    white-space:nowrap;text-shadow:0 0 14px rgba(255,120,90,.45)}`;
  const files = [];
  for (const [i, c] of CAPTIONS.entries()) {
    await page.setContent(`<html><head>${font}<style>${capCss}</style></head><body><div class="cap">${c.text}</div></body></html>`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const f = path.join(WORK, `cap_${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: f, omitBackground: true });
    files.push(f);
  }
  // End card over a still of the vault scene.
  const bg = path.join(WORK, "endcard-bg.jpg");
  ff(["-ss", "89.2", "-i", TAKE, "-frames:v", "1", bg]);
  const bgData = fs.readFileSync(bg).toString("base64");
  await page.setContent(`<html><head>${font}<style>
    html,body{margin:0;width:1920px;height:1080px;background:#000;overflow:hidden}
    .bg{position:absolute;inset:-40px;background:url(data:image/jpeg;base64,${bgData}) center/cover;filter:blur(14px) brightness(.38) saturate(1.2)}
    .v{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,transparent 20%,rgba(0,0,0,.8) 100%)}
    .c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'VT323',monospace;color:#fff3ee;text-transform:uppercase;letter-spacing:.05em}
    h1{margin:0;font-size:230px;line-height:.9;font-weight:400;color:#ff3b1f;text-shadow:0 0 40px rgba(255,59,31,.55)}
    .s{font-size:64px;margin-top:18px}
    .r{font-size:44px;margin-top:34px;color:rgba(255,232,224,.86)}
    .u{font-size:56px;margin-top:40px;padding:6px 22px;border:3px solid #fff3ee}
  </style></head><body><div class="bg"></div><div class="v"></div><div class="c">
    <h1>T1000</h1><div class="s">Idle stablecoins · allocated · guarded</div>
    <div class="r">Reasoning: SERV · Execution: AgentKit · IXS · Base · Robinhood Chain</div>
    <div class="u">serv-t1000.vercel.app</div></div></body></html>`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const card = path.join(WORK, "endcard.png");
  await page.screenshot({ path: card });
  await browser.close();
  return { caps: files, card };
}

(async () => {
  // 1. Body: take segments with the live-proof inserts interleaved, each cut, retimed and encoded alike.
  const plan = [];
  SEGMENTS.forEach((sg, i) => {
    plan.push(sg);
    for (const ins of INSERTS.filter((x) => x.afterSeg === i)) plan.push(...ins.clips);
  });
  const segFiles = plan.map((c, i) => {
    const f = path.join(WORK, `seg_${i}.mp4`);
    if (process.env.REUSE_SEGS && fs.existsSync(f)) return f;
    const enc = ["-an", "-c:v", "libx264", "-crf", "15", "-preset", "medium", "-pix_fmt", "yuv420p", f];
    if (c.still) {
      const n = Math.round((c.dur / PACE) * 30);
      ff(["-loop", "1", "-framerate", "30", "-t", String(c.dur / PACE), "-i", c.still, "-vf",
        `scale=3840:-1,zoompan=z='1+0.06*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30`, ...enc]);
    } else {
      const pre = c.vf ? `${c.vf},` : "";
      ff(["-ss", String(c.from), "-to", String(c.to), "-i", c.src ?? TAKE, "-vf", `${pre}setpts=(PTS-STARTPTS)/${c.speed * PACE},fps=30,format=yuv420p`, ...enc]);
    }
    return f;
  });
  // Join by decoding (concat filter): stream-copy joins broke at the seam where clips from other encoders begin.
  const body = path.join(WORK, "body.mp4");
  ff([...segFiles.flatMap((f) => ["-i", f]), "-filter_complex",
    segFiles.map((_, i) => `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p[s${i}]`).join(";") + ";" + segFiles.map((_, i) => `[s${i}]`).join("") + `concat=n=${segFiles.length}:v=1:a=0[v]`,
    "-map", "[v]", "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p", body]);
  const introLen = dur(INTRO) / PACE;
  // Map original 1x timeline times past the inserts, then to the paced timeline.
  const bodyStart1x = dur(INTRO) - 0.9;
  const insAt = INSERTS.map((ins) => bodyStart1x + SEGMENTS.slice(0, ins.afterSeg + 1).reduce((a, sg) => a + (sg.to - sg.from) / sg.speed, 0));
  const insLen = INSERTS.map((ins) => ins.clips.reduce((a, c) => a + clipLen(c), 0));
  const shift1x = (t) => t + INSERTS.reduce((a, _, k) => a + (t >= insAt[k] - 0.05 ? insLen[k] : 0), 0);
  const at = (t) => shift1x(t) / PACE;
  const insertCaptions = INSERTS.flatMap((ins, k) => {
    const start = insAt[k] + insLen.slice(0, k).reduce((a, x) => a + x, 0);
    return ins.captions.map((c) => ({ t: [start + c.t[0], start + c.t[1]], text: c.text, placed: true }));
  });
  CAPTIONS.push(...insertCaptions);
  const bodyLen = dur(body);
  const bodyStart = introLen - XFADE;
  const bodyEnd = bodyStart + bodyLen;
  console.log(`intro ${introLen.toFixed(2)}s, body ${bodyLen.toFixed(2)}s -> body on timeline ${bodyStart.toFixed(2)}-${bodyEnd.toFixed(2)}s`);

  // 2. Captions + end card.
  const { caps, card } = await renderStills(bodyEnd);
  const total = bodyEnd - 0.6 + END_CARD;

  // 3. Video graph: intro -circleopen-> body -fade-> end card, then caption overlays.
  const inputs = ["-i", INTRO, "-i", body, "-loop", "1", "-t", String(END_CARD), "-i", card];
  caps.forEach((c) => inputs.push("-i", c));
  let g = `[0:v]setpts=PTS/${PACE},fps=30,format=yuv420p,settb=AVTB[i];[1:v]settb=AVTB[b];[2:v]fps=30,format=yuv420p,settb=AVTB[e];`;
  g += `[i][b]xfade=transition=circleopen:duration=${XFADE}:offset=${bodyStart.toFixed(3)}[ib];`;
  g += `[ib][e]xfade=transition=fade:duration=0.6:offset=${(bodyEnd - 0.6).toFixed(3)}[v0];`;
  CAPTIONS.forEach((c, i) => {
    const [a, b] = c.placed ? [c.t[0] / PACE, c.t[1] / PACE] : [at(c.t[0]), at(c.t[1])];
    g += `[v${i}][${3 + i}:v]overlay=0:0:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'[v${i + 1}];`;
  });
  const vOut = `v${CAPTIONS.length}`;

  // 4. Audio, in separate passes (one graph splitting a shared VO stream nine ways deadlocked once the cut grew):
  //    each line to its own file -> voice track -> music ducked under it -> loudness. The video pass only muxes.
  const lineFiles = VO_LINES.map((l, k) => {
    const f = path.join(WORK, `vo_${k}.wav`);
    const len = (l.end - l.start + 0.02) / PACE;
    ff(["-i", l.file, "-af", `atrim=start=${Math.max(0, l.start - 0.05)}:end=${l.end + 0.12},asetpts=PTS-STARTPTS,atempo=${PACE},afade=t=out:st=${len.toFixed(3)}:d=0.1,aformat=sample_rates=48000:channel_layouts=stereo`, f]);
    return f;
  });
  const voice = path.join(WORK, "voice.wav");
  {
    let vg = "";
    VO_LINES.forEach((l, k) => {
      const start = l.beat === "end" ? bodyEnd - 0.6 + 0.45 : at(VO_AT[l.beat]);
      vg += `[${k}:a]adelay=delays=${Math.round(start * 1000)}:all=1[d${k}];`;
    });
    vg += VO_LINES.map((_, k) => `[d${k}]`).join("") + `amix=inputs=${VO_LINES.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)},atrim=end=${total.toFixed(3)}[out]`;
    ff([...lineFiles.flatMap((f) => ["-i", f]), "-filter_complex", vg, "-map", "[out]", voice]);
  }
  const mix = path.join(WORK, "mix.wav");
  if (MUSIC) {
    // Measured: voice ~-15 dB mean, this track ~-11 dB once its percussion enters. Intro 0.6 (music leads);
    // a 1.5s ramp down to 0.14 puts the bed ~15 dB under the voice, and the sidechain dips it further on every line.
    const t0 = bodyStart.toFixed(2);
    const mg = `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=end=${total.toFixed(3)},volume='if(lt(t,${t0}),0.6,if(lt(t,${t0}+1.5),0.6-0.46*(t-${t0})/1.5,0.14))':eval=frame,afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[bed];` +
      `[0:a]asplit=2[v1][key];[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked];` +
      `[v1][ducked]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`;
    ff(["-i", voice, "-i", MUSIC, "-filter_complex", mg, "-map", "[out]", mix]);
  } else {
    ff(["-i", voice, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000", mix]);
  }
  inputs.push("-i", mix);
  const aIdx = 3 + caps.length;
  g = g.replace(/;$/, "");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const finalArgs = [...inputs, "-filter_complex", g, "-map", `[${vOut}]`, "-map", `${aIdx}:a`, "-t", total.toFixed(3),
    "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", OUT];
  if (process.env.BUILD_DEBUG) fs.writeFileSync(path.join(WORK, "final-ffmpeg.json"), JSON.stringify(finalArgs));
  ff(finalArgs);
  console.log(`wrote ${OUT} (${dur(OUT).toFixed(2)}s)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
