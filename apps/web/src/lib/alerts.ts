/**
 * Glanceable audio + voice alerts — the monitor's alert layer, in-shell. Fits
 * Kaden's second-monitor setup: a chime (and optional spoken line) fires on
 * high-signal live events (raid start/end, run-through cleared, scav ready,
 * agent nudges) so you don't have to watch the panel while tabbed into the game.
 *
 * Everything audio is GUARDED: unsupported or autoplay-blocked APIs no-op and
 * never throw. Per browser autoplay policy an AudioContext starts suspended, so
 * `unlockAudio()` must be called from a user gesture (the enable toggle) before
 * the first chime. Prefs persist in localStorage and are read fresh on each
 * fire, so the engine needs no React wiring.
 */

export interface AlertPrefs {
  enabled: boolean;
  voice: boolean;
}

const KEY = "tac.alerts";
const DEFAULTS: AlertPrefs = { enabled: false, voice: false };

export function getAlertPrefs(): AlertPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<AlertPrefs>;
    return { enabled: p.enabled === true, voice: p.voice === true };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setAlertPrefs(prefs: AlertPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable — prefs just won't persist across reloads
  }
}

// ---------------------------------------------------------------- audio

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/** Call from a user gesture (enable toggle) to satisfy autoplay policy. */
export function unlockAudio(): void {
  const ac = audioContext();
  if (ac && ac.state === "suspended") void ac.resume().catch(() => {});
}

/** A short, pleasant two-note chime built from oscillators (no asset needed). */
export function playChime(): void {
  const ac = audioContext();
  if (!ac) return;
  try {
    if (ac.state === "suspended") void ac.resume().catch(() => {});
    const now = ac.currentTime;
    const notes: { freq: number; at: number }[] = [
      { freq: 660, at: 0 },
      { freq: 990, at: 0.14 },
    ];
    for (const { freq, at } of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    }
  } catch {
    // audio graph failed — silent, never fatal
  }
}

function speak(text: string): void {
  try {
    const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.volume = 0.9;
    synth.speak(u);
  } catch {
    // TTS unavailable — silent
  }
}

/**
 * Fire an alert if enabled: always a chime, plus a spoken line when voice is on.
 * `spoken` lets the caller pass a shorter phrase than the on-screen message.
 */
export function fireAlert(message: string, opts: { spoken?: string } = {}): void {
  const prefs = getAlertPrefs();
  if (!prefs.enabled) return;
  playChime();
  if (prefs.voice) speak(opts.spoken ?? message);
}
