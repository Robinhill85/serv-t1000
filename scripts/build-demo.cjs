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

const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
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
  // 1. Body: cut and retime take segments, then join.
  const segFiles = SEGMENTS.map((s, i) => {
    const f = path.join(WORK, `seg_${i}.mp4`);
    ff(["-ss", String(s.from), "-to", String(s.to), "-i", TAKE, "-an", "-vf", `setpts=(PTS-STARTPTS)/${s.speed * PACE},fps=30,format=yuv420p`, "-c:v", "libx264", "-crf", "15", "-preset", "medium", f]);
    return f;
  });
  const list = path.join(WORK, "segs.txt");
  fs.writeFileSync(list, segFiles.map((f) => `file '${f}'`).join("\n") + "\n");
  const body = path.join(WORK, "body.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", body]);
  const introLen = dur(INTRO) / PACE;
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
  CAPTIONS.forEach((c, i) => { g += `[v${i}][${3 + i}:v]overlay=0:0:enable='between(t,${(c.t[0] / PACE).toFixed(3)},${(c.t[1] / PACE).toFixed(3)})'[v${i + 1}];`; });
  const vOut = `v${CAPTIONS.length}`;

  // 4. Audio: each VO line cut from Arthur's read and placed on its beat; optional music bed ducked under the voice.
  const voFiles = [...new Set(VO_LINES.map((l) => l.file))];
  const voIdxOf = (f) => 3 + caps.length + voFiles.indexOf(f);
  voFiles.forEach((f) => inputs.push("-i", f));
  VO_LINES.forEach((l, k) => {
    const at = l.beat === "end" ? bodyEnd - 0.6 + 0.45 : VO_AT[l.beat] / PACE;
    const len = (l.end - l.start + 0.02) / PACE;
    g += `[${voIdxOf(l.file)}:a]atrim=start=${Math.max(0, l.start - 0.05)}:end=${l.end + 0.12},asetpts=PTS-STARTPTS,atempo=${PACE},afade=t=out:st=${len.toFixed(3)}:d=0.1,adelay=delays=${Math.round(at * 1000)}:all=1[vo${k}];`;
  });
  g += VO_LINES.map((_, k) => `[vo${k}]`).join("") + `amix=inputs=${VO_LINES.length}:normalize=0,apad,atrim=end=${total.toFixed(3)},aformat=channel_layouts=stereo[voice];`;
  let aOut = "voice";
  if (MUSIC) {
    const mIdx = 3 + caps.length + voFiles.length;
    inputs.push("-i", MUSIC);
    // Music carries the intro, then sits low; the sidechain ducks it further whenever Arthur speaks.
    g += `[voice]asplit=2[voice1][key];`;
    // Measured: voice ~-15 dB mean, this track ~-11 dB once its percussion enters. Intro 0.6 (music leads);
    // a 1.5s ramp down to 0.14 puts the bed ~15 dB under the voice, and the sidechain dips it further on every line.
    const t0 = bodyStart.toFixed(2);
    g += `[${mIdx}:a]aformat=channel_layouts=stereo,atrim=end=${total.toFixed(3)},volume='if(lt(t,${t0}),0.6,if(lt(t,${t0}+1.5),0.6-0.46*(t-${t0})/1.5,0.14))':eval=frame,afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[bed];`;
    g += `[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked];`;
    g += `[voice1][ducked]amix=inputs=2:normalize=0[mix];`;
    aOut = "mix";
  }
  g += `[${aOut}]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  ff([...inputs, "-filter_complex", g, "-map", `[${vOut}]`, "-map", "[aout]", "-t", total.toFixed(3),
    "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", OUT]);
  console.log(`wrote ${OUT} (${dur(OUT).toFixed(2)}s)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
