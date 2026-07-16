/**
 * The monitor window: one self-contained HTML document (inline CSS + JS, no
 * build step, no external assets). It receives live state + alert cues over
 * SSE (GET /events) and plays chimes (Web Audio) and voice callouts
 * (SpeechSynthesis) — the browser is a dumb renderer; all logic lives in the
 * engine. Audio prefs are device-local (localStorage); alert/timing/submission
 * config is server-side and toggled via POST /config.
 *
 * The embedded browser script deliberately avoids template literals so this
 * outer template literal never mis-parses a `${` from the page.
 * @tier T0
 */
export function monitorPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TAC Monitor</title>
<style>
  :root {
    --bg: #0e1113; --panel: #171b1f; --panel2: #1e242a; --line: #2b333b;
    --text: #d7e0e6; --muted: #7c8a95; --accent: #c7a35a; --good: #5db075;
    --warn: #d98c3f; --bad: #cc5b4e; --live: #4ea1d3;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 "Segoe UI", system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 14px; padding: 12px 18px;
    background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
  .brand { font-weight: 700; letter-spacing: .5px; color: var(--accent); }
  .status { display: flex; align-items: center; gap: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.on { background: var(--good); box-shadow: 0 0 8px var(--good); }
  .dot.off { background: var(--bad); }
  .muted { color: var(--muted); }
  .spacer { flex: 1; }
  button { font: inherit; color: var(--text); background: var(--panel2);
    border: 1px solid var(--line); border-radius: 7px; padding: 7px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); color: #1a1400; border-color: var(--accent); font-weight: 600; }
  button.armed { background: #22331f; border-color: var(--good); color: var(--good); }
  main { max-width: 900px; margin: 0 auto; padding: 18px; display: grid; gap: 14px; }
  .row { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase;
    letter-spacing: 1.2px; color: var(--muted); font-weight: 600; }
  .raid .phase { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .raid .map { font-size: 26px; font-weight: 700; margin: 2px 0 8px; }
  .bigtime { font-size: 44px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
  .bigtime.live { color: var(--live); }
  .bar { height: 8px; border-radius: 5px; background: var(--panel2); overflow: hidden; margin: 8px 0 4px; }
  .bar > i { display: block; height: 100%; background: var(--warn); width: 0%; transition: width .3s linear; }
  .bar.done > i { background: var(--good); }
  .kv { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted); font-size: 13px; margin-top: 6px; }
  .kv b { color: var(--text); font-variant-numeric: tabular-nums; }
  .scav .bigtime { color: var(--accent); }
  .scav .bigtime.ready { color: var(--good); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .stat { text-align: center; background: var(--panel2); border-radius: 9px; padding: 12px 6px; }
  .stat .n { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; }
  .maplist, .log { display: grid; gap: 6px; max-height: 220px; overflow: auto; }
  .maplist .m, .log .e { display: flex; justify-content: space-between; padding: 6px 8px;
    background: var(--panel2); border-radius: 7px; font-size: 13px; }
  .log .e .t { color: var(--muted); font-variant-numeric: tabular-nums; }
  .log .e.new { outline: 1px solid var(--accent); }
  details.settings { }
  details.settings > summary { cursor: pointer; color: var(--muted); font-size: 12px;
    text-transform: uppercase; letter-spacing: 1.2px; font-weight: 600; }
  .set-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
  .set-grid h3 { font-size: 12px; color: var(--accent); margin: 0 0 8px; text-transform: uppercase; letter-spacing: 1px; }
  label.chk { display: flex; align-items: center; gap: 8px; padding: 3px 0; cursor: pointer; }
  input[type=number] { width: 80px; background: var(--panel2); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; }
  select { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px; }
  input[type=range] { width: 130px; }
  .note { font-size: 12px; color: var(--muted); margin: 6px 0; }
  .warnbox { background: #2a2018; border: 1px solid var(--warn); border-radius: 8px; padding: 10px; font-size: 12px; color: #e6c99b; margin-bottom: 10px; }
  .banner { background: var(--accent); color: #1a1400; text-align: center; padding: 8px; font-weight: 600; cursor: pointer; }
  .hidden { display: none; }
</style>
</head>
<body>
<div id="sound-banner" class="banner">🔇 Click to enable sound &amp; voice callouts</div>
<header>
  <div class="brand">◎ TAC MONITOR</div>
  <div class="status"><span id="conn" class="dot"></span><span id="conn-label" class="muted">connecting…</span></div>
  <span id="profile" class="muted"></span>
  <div class="spacer"></div>
  <button id="enable-sound">🔊 Enable sound</button>
</header>
<main>
  <div class="row">
    <section class="card raid">
      <h2>Live raid</h2>
      <div class="phase" id="r-phase">Idle</div>
      <div class="map" id="r-map">—</div>
      <div class="bigtime" id="r-time">—</div>
      <div class="bar" id="r-bar"><i></i></div>
      <div id="r-runthrough" class="note">Run-through timer idle</div>
      <div class="kv"><span>Queue <b id="r-queue">—</b></span><span>Mode <b id="r-mode">—</b></span></div>
    </section>
    <section class="card scav">
      <h2>Scav cooldown</h2>
      <div class="bigtime" id="s-time">—</div>
      <div class="bar" id="s-bar"><i></i></div>
      <div class="note" id="s-note">Estimate — calibrate the base below.</div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button id="s-start" class="primary">Scav out</button>
        <button id="s-clear">Reset</button>
      </div>
    </section>
  </div>

  <section class="card">
    <h2>This session</h2>
    <div class="stats">
      <div class="stat"><div class="n" id="st-raids">0</div><div class="l">Raids</div></div>
      <div class="stat"><div class="n" id="st-sales">0</div><div class="l">Flea sales</div></div>
      <div class="stat"><div class="n" id="st-rub">0</div><div class="l">Roubles</div></div>
    </div>
    <div class="maplist" id="st-maps" style="margin-top:12px;"></div>
  </section>

  <section class="card">
    <h2>Alerts</h2>
    <div class="log" id="log"></div>
  </section>

  <details class="card settings">
    <summary>Settings</summary>
    <div class="set-grid">
      <div>
        <h3>Audio (this device)</h3>
        <label class="chk"><input type="checkbox" id="a-voice" /> Voice callouts</label>
        <label class="chk"><input type="checkbox" id="a-chimes" /> Chimes</label>
        <label class="chk">Volume <input type="range" id="a-vol" min="0" max="1" step="0.05" /></label>
        <h3 style="margin-top:16px;">Timing</h3>
        <label class="chk">Run-through <input type="number" id="t-run" min="1" /> s</label>
        <label class="chk">Scav base <input type="number" id="t-scav" min="1" /> s</label>
        <button id="t-save">Save timing</button>
      </div>
      <div>
        <h3>Alerts</h3>
        <div id="alert-toggles"></div>
        <h3 style="margin-top:16px;">Community (tarkov.dev)</h3>
        <div class="warnbox">Experimental &amp; off by default. Queue times are anonymous; goons reports include your account id. Verify before enabling.</div>
        <label class="chk"><input type="checkbox" id="c-queue" /> Submit queue times</label>
        <label class="chk"><input type="checkbox" id="c-goons" /> Submit goons sightings</label>
        <div class="note" id="c-acct"></div>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <select id="g-map">
            <option value="">current map</option>
            <option value="bigmap">Customs</option>
            <option value="woods">Woods</option>
            <option value="shoreline">Shoreline</option>
            <option value="lighthouse">Lighthouse</option>
            <option value="tarkovstreets">Streets</option>
          </select>
          <button id="g-report">Report goons</button>
        </div>
      </div>
    </div>
  </details>
</main>
<script>
"use strict";
var lastState = null, lastRecv = 0, audioCtx = null;
var soundEnabled = localStorage.getItem("tac_sound") === "1";
var voiceOn = localStorage.getItem("tac_voice") !== "0";
var chimesOn = localStorage.getItem("tac_chimes") !== "0";
var volume = parseFloat(localStorage.getItem("tac_vol") || "0.5");

function $(id) { return document.getElementById(id); }
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var ss = (s < 10 ? "0" : "") + s;
  if (h > 0) { var mm = (m < 10 ? "0" : "") + m; return h + ":" + mm + ":" + ss; }
  return m + ":" + ss;
}
function postJSON(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}

// ---- audio -------------------------------------------------------------
function ensureCtx() {
  if (!audioCtx) { var C = window.AudioContext || window.webkitAudioContext; if (C) audioCtx = new C(); }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function playChime(pattern) {
  if (!soundEnabled || !chimesOn) return;
  var ctx = ensureCtx(); if (!ctx) return;
  var map = { up: [[520,0],[780,0.12]], down: [[600,0],[380,0.12]], double: [[680,0],[680,0.14]],
    success: [[523,0],[659,0.1],[784,0.2]], warn: [[220,0],[175,0.2]] };
  var notes = map[pattern] || [[600,0]];
  for (var i = 0; i < notes.length; i++) {
    var f = notes[i][0], t = notes[i][1];
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = f;
    var start = ctx.currentTime + t;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    o.connect(g); g.connect(ctx.destination); o.start(start); o.stop(start + 0.22);
  }
}
function speak(text) {
  if (!soundEnabled || !voiceOn || !("speechSynthesis" in window)) return;
  var u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05; u.volume = Math.min(1, volume * 1.8);
  window.speechSynthesis.speak(u);
}
function armSound() {
  soundEnabled = true; localStorage.setItem("tac_sound", "1");
  ensureCtx(); $("sound-banner").classList.add("hidden");
  var b = $("enable-sound"); b.textContent = "🔊 Sound on"; b.classList.add("armed");
  playChime("success"); speak("Monitor armed.");
}
$("enable-sound").onclick = armSound;
$("sound-banner").onclick = armSound;

// ---- alert log ---------------------------------------------------------
function onAlert(a) {
  playChime(a.chime);
  speak(a.say);
  var log = $("log");
  var e = document.createElement("div");
  e.className = "e new";
  var d = new Date(a.ts);
  var hh = ("0" + d.getHours()).slice(-2), mm = ("0" + d.getMinutes()).slice(-2), ssx = ("0" + d.getSeconds()).slice(-2);
  e.innerHTML = "<span>" + a.title + " — " + a.say + "</span><span class='t'>" + hh + ":" + mm + ":" + ssx + "</span>";
  log.insertBefore(e, log.firstChild);
  setTimeout(function () { e.classList.remove("new"); }, 2500);
  while (log.children.length > 40) log.removeChild(log.lastChild);
}

// ---- render ------------------------------------------------------------
var ALERT_LABELS = { "match-created": "Queue entered", "match-found": "Match found",
  "raid-start": "Raid started", "runthrough-safe": "Run-through cleared", "raid-end": "Raid ended",
  "scav-ready": "Scav available", "flea-sale": "Flea sale", "quest-done": "Quest completed",
  "quest-failed": "Task failed" };
var togglesBuilt = false;

function buildAlertToggles(cfg) {
  if (togglesBuilt) return;
  togglesBuilt = true;
  var wrap = $("alert-toggles");
  Object.keys(cfg.alerts).forEach(function (id) {
    var lab = document.createElement("label"); lab.className = "chk";
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.dataset.alert = id;
    cb.onchange = function () {
      var patch = { alerts: {} }; patch.alerts[id] = cb.checked;
      postJSON("/config", patch);
    };
    lab.appendChild(cb); lab.appendChild(document.createTextNode(" " + (ALERT_LABELS[id] || id)));
    wrap.appendChild(lab);
  });
}

function focused(el) { return document.activeElement === el; }

function render() {
  if (!lastState) return;
  var s = lastState, delta = (Date.now() - lastRecv) / 1000;
  var r = s.raid;

  $("conn").className = "dot " + (s.connected ? "on" : "off");
  $("conn-label").textContent = s.connected ? "service connected" : "service offline";
  $("profile").textContent = s.profileKey ? "profile: " + s.profileKey : "";

  var phaseLabels = { idle: "Idle", queued: "In queue", confirmed: "Match found", "in-raid": "● In raid" };
  $("r-phase").textContent = phaseLabels[r.phase] || r.phase;
  $("r-map").textContent = r.mapName || "—";
  $("r-mode").textContent = r.mode || "—";
  $("r-queue").textContent = r.queueSec != null ? fmt(r.queueSec) : "—";

  var inRaid = r.phase === "in-raid";
  var elapsed = inRaid ? r.inRaidSec + delta : 0;
  $("r-time").textContent = inRaid ? fmt(elapsed) : "—";
  $("r-time").className = "bigtime" + (inRaid ? " live" : "");

  var thr = r.runthrough.thresholdSec;
  var rem = Math.max(0, thr - elapsed);
  var bar = $("r-bar"), fill = bar.firstChild;
  if (inRaid) {
    var met = elapsed >= thr;
    bar.className = "bar" + (met ? " done" : "");
    fill.style.width = Math.min(100, (elapsed / thr) * 100) + "%";
    $("r-runthrough").innerHTML = met
      ? "<span style='color:var(--good)'>✓ Extract counts as Survived</span>"
      : "Run-through in <b>" + fmt(rem) + "</b> <span class='muted'>(or earn 200 EXP)</span>";
  } else {
    bar.className = "bar"; fill.style.width = "0%";
    $("r-runthrough").innerHTML = "<span class='muted'>Run-through timer idle</span>";
  }

  var sc = s.scav, sRem = sc.active ? Math.max(0, sc.remainingSec - delta) : 0;
  var ready = sc.active && sRem <= 0;
  $("s-time").textContent = sc.active ? (ready ? "Ready" : fmt(sRem)) : "Idle";
  $("s-time").className = "bigtime" + (ready ? " ready" : "");
  var sbar = $("s-bar"), sfill = sbar.firstChild;
  if (sc.active) {
    sbar.className = "bar" + (ready ? " done" : "");
    sfill.style.width = Math.min(100, ((sc.cooldownSec - sRem) / sc.cooldownSec) * 100) + "%";
  } else { sbar.className = "bar"; sfill.style.width = "0%"; }
  $("s-note").textContent = "Base " + fmt(sc.cooldownSec) + " — estimate, calibrate below.";

  $("st-raids").textContent = s.stats.raids;
  $("st-sales").textContent = s.stats.fleaSales;
  $("st-rub").textContent = (s.stats.fleaRoubles || 0).toLocaleString("en-US");
  var maps = $("st-maps"); maps.innerHTML = "";
  var entries = Object.keys(s.stats.byMap).map(function (k) { return [k, s.stats.byMap[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; });
  entries.forEach(function (e) {
    var d = document.createElement("div"); d.className = "m";
    d.innerHTML = "<span>" + e[0] + "</span><b>" + e[1] + "</b>"; maps.appendChild(d);
  });
  if (entries.length === 0) maps.innerHTML = "<div class='note'>No raids yet this session.</div>";

  // config controls
  buildAlertToggles(s.config);
  var toggles = document.querySelectorAll("#alert-toggles input");
  for (var i = 0; i < toggles.length; i++) { var id = toggles[i].dataset.alert; toggles[i].checked = !!s.config.alerts[id]; }
  if (!focused($("t-run"))) $("t-run").value = s.config.runthroughSec;
  if (!focused($("t-scav"))) $("t-scav").value = s.config.scavCooldownSec;
  $("c-queue").checked = s.config.submitQueueTimes;
  $("c-goons").checked = s.config.submitGoons;
  $("c-acct").textContent = s.config.hasAccountId ? "Account id configured." : "No account id set (goons reports need TAC_MONITOR_ACCOUNT_ID).";
}

// ---- controls ----------------------------------------------------------
$("s-start").onclick = function () { postJSON("/scav/start"); };
$("s-clear").onclick = function () { postJSON("/scav/clear"); };
$("t-save").onclick = function () {
  postJSON("/config", { runthroughSec: Number($("t-run").value), scavCooldownSec: Number($("t-scav").value) });
};
$("c-queue").onchange = function () { postJSON("/config", { submitQueueTimes: $("c-queue").checked }); };
$("c-goons").onchange = function () { postJSON("/config", { submitGoons: $("c-goons").checked }); };
$("g-report").onclick = function () {
  postJSON("/goons", { map: $("g-map").value || undefined }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) alert("Goons report not sent: " + (j.reason || "unknown"));
  });
};
$("a-voice").checked = voiceOn; $("a-chimes").checked = chimesOn; $("a-vol").value = volume;
$("a-voice").onchange = function () { voiceOn = $("a-voice").checked; localStorage.setItem("tac_voice", voiceOn ? "1" : "0"); };
$("a-chimes").onchange = function () { chimesOn = $("a-chimes").checked; localStorage.setItem("tac_chimes", chimesOn ? "1" : "0"); };
$("a-vol").oninput = function () { volume = parseFloat($("a-vol").value); localStorage.setItem("tac_vol", String(volume)); };

if (soundEnabled) { $("sound-banner").classList.add("hidden"); var eb = $("enable-sound"); eb.textContent = "🔊 Sound on"; eb.classList.add("armed"); }

// ---- SSE ---------------------------------------------------------------
function connect() {
  var es = new EventSource("/events");
  es.onmessage = function (ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.kind === "state") { lastState = msg.state; lastRecv = Date.now(); render(); }
    else if (msg.kind === "alert") { onAlert(msg.alert); }
  };
  es.onerror = function () { $("conn").className = "dot off"; $("conn-label").textContent = "reconnecting…"; };
}
connect();
setInterval(render, 250);
</script>
</body>
</html>`;
}
