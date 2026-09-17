/**
 * Sound: a small synthesiser for the soundtrack, plus sampled cries.
 *
 * The pipeline reduces each MIDI track to note events rather than rendering
 * audio, so music is a few kilobytes per song and is voiced here with
 * oscillators — which suits the GBA-era material it came from. Notes are
 * scheduled on a look-ahead timer so playback stays steady even when the game
 * loop stutters.
 */
import { loadAudioBuffer } from './assets.mjs';
import { url } from './bridge.mjs';

/** How far ahead notes are queued, and how often the queue is topped up. */
const LOOKAHEAD_S = 0.4;
const TICK_MS = 120;

/** Hard cap on notes started per scheduling tick, so a dense bar cannot stall. */
const MAX_NOTES_PER_TICK = 64;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {GainNode|null} */
    this.musicGain = null;
    /** @type {GainNode|null} */
    this.effectGain = null;
    /** @type {AudioBuffer|null} */
    this.noise = null;

    /** @type {{name: string, song: any, startedAt: number, cursors: number[], loops: number}|null} */
    this.current = null;
    /** @type {number|undefined} */
    this.timer = undefined;
    /** @type {Map<string, Promise<any>>} */
    this.songs = new Map();
    /** @type {Map<string, Promise<AudioBuffer>>} */
    this.buffers = new Map();

    this.musicVolume = 0.6;
    this.effectVolume = 0.8;
  }

  /** Create the audio graph. Safe to call more than once. */
  start() {
    if (this.context) return;
    this.context = new AudioContext();
    this.musicGain = this.context.createGain();
    this.effectGain = this.context.createGain();
    this.musicGain.connect(this.context.destination);
    this.effectGain.connect(this.context.destination);
    this.applyVolumes();
    this.noise = createNoiseBuffer(this.context);
  }

  /** @param {{musicVolume?: number, effectVolume?: number}} volumes */
  setVolumes({ musicVolume, effectVolume }) {
    if (typeof musicVolume === 'number') this.musicVolume = musicVolume;
    if (typeof effectVolume === 'number') this.effectVolume = effectVolume;
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.context || !this.musicGain || !this.effectGain) return;
    const now = this.context.currentTime;
    // Music is mixed low: it plays under whatever the user is actually doing.
    this.musicGain.gain.setTargetAtTime(this.musicVolume * 0.22, now, 0.05);
    this.effectGain.gain.setTargetAtTime(this.effectVolume * 0.5, now, 0.05);
  }

  /**
   * Play a track from `assets/bgm`, looping until something else is asked for.
   * @param {string|null} name
   */
  async playMusic(name) {
    if (!name) return this.stopMusic();
    this.start();
    if (this.current?.name === name) return;

    const song = await this.loadSong(name);
    if (!this.context) return;

    this.stopMusic();
    this.current = {
      name,
      song,
      startedAt: this.context.currentTime + 0.1,
      cursors: song.tracks.map(() => 0),
      loops: 0,
    };
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  stopMusic() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.current = null;
  }

  /** Queue every note that starts within the look-ahead window. */
  schedule() {
    if (!this.context || !this.current || !this.musicGain) return;
    const { song, cursors } = this.current;
    const horizon = this.context.currentTime + LOOKAHEAD_S;
    let started = 0;

    // A song shorter than the look-ahead would otherwise schedule the same loop
    // repeatedly; advancing the origin as soon as the cursor runs out keeps one
    // iteration in flight at a time.
    for (let pass = 0; pass < 4; pass++) {
      const origin = this.current.startedAt + this.current.loops * song.duration;
      let exhausted = true;

      song.tracks.forEach((track, index) => {
        while (cursors[index] < track.notes.length && started < MAX_NOTES_PER_TICK) {
          const note = track.notes[cursors[index]];
          const when = origin + note.t;
          if (when > horizon) {
            exhausted = false;
            return;
          }
          this.playNote(track.program, note, Math.max(when, this.context.currentTime));
          cursors[index]++;
          started++;
        }
        if (cursors[index] < track.notes.length) exhausted = false;
      });

      if (started >= MAX_NOTES_PER_TICK) return;
      if (!exhausted) return;

      this.current.loops++;
      cursors.fill(0);
    }
  }

  /**
   * @param {number} program General MIDI program, 128 for percussion
   * @param {{t: number, d: number, n: number, v: number}} note
   * @param {number} when
   */
  playNote(program, note, when) {
    if (!this.context || !this.musicGain) return;
    const voice = voiceFor(program);
    const duration = Math.min(note.d, 4);
    const gain = this.context.createGain();
    gain.connect(this.musicGain);

    /** @type {AudioScheduledSourceNode} */
    let source;
    if (voice.wave === 'noise') {
      const buffer = this.context.createBufferSource();
      buffer.buffer = this.noise;
      buffer.loop = true;
      const filter = this.context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = midiToFrequency(note.n);
      filter.Q.value = 1.2;
      buffer.connect(filter);
      filter.connect(gain);
      source = buffer;
    } else {
      const oscillator = this.context.createOscillator();
      oscillator.type = /** @type {OscillatorType} */ (voice.wave);
      oscillator.frequency.value = midiToFrequency(note.n + voice.transpose);
      oscillator.connect(gain);
      source = oscillator;
    }

    const peak = note.v * voice.gain;
    const attack = voice.attack;
    const release = Math.min(voice.release, duration);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.setTargetAtTime(peak * voice.sustain, when + attack, Math.max(0.02, duration / 3));
    gain.gain.setTargetAtTime(0.0001, when + duration, release / 3);

    source.start(when);
    source.stop(when + duration + release);
    source.onended = () => gain.disconnect();
  }

  /**
   * A Pokémon's cry. Missing cries are simply silent rather than fatal.
   * @param {number} speciesId
   */
  async playCry(speciesId) {
    await this.playSample(`cries/${speciesId}.ogg`);
  }

  /** @param {string} path */
  async playSample(path) {
    this.start();
    if (!this.context || !this.effectGain) return;
    try {
      let pending = this.buffers.get(path);
      if (!pending) {
        pending = loadAudioBuffer(this.context, path);
        this.buffers.set(path, pending);
      }
      const source = this.context.createBufferSource();
      source.buffer = await pending;
      source.connect(this.effectGain);
      source.start();
    } catch {
      // A missing sample should never interrupt the game.
    }
  }

  /**
   * Interface blips, synthesised so the game ships no sound-effect files.
   * @param {'select'|'confirm'|'cancel'|'error'|'hit'|'faint'|'catch'} kind
   */
  blip(kind) {
    this.start();
    if (!this.context || !this.effectGain) return;
    const spec = BLIPS[kind] ?? BLIPS.select;
    const now = this.context.currentTime;

    spec.steps.forEach((step, index) => {
      const oscillator = /** @type {AudioContext} */ (this.context).createOscillator();
      const gain = /** @type {AudioContext} */ (this.context).createGain();
      oscillator.type = spec.wave;
      oscillator.frequency.value = step.frequency;
      oscillator.connect(gain);
      gain.connect(/** @type {GainNode} */ (this.effectGain));

      const at = now + index * spec.gap;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.35, at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + step.length);
      oscillator.start(at);
      oscillator.stop(at + step.length + 0.02);
      oscillator.onended = () => gain.disconnect();
    });
  }

  /** @param {string} name */
  loadSong(name) {
    let pending = this.songs.get(name);
    if (!pending) {
      pending = fetch(url('assets', `bgm/${name}.json`)).then((response) => {
        if (!response.ok) throw new Error(`No track ${name}`);
        return response.json();
      });
      this.songs.set(name, pending);
    }
    return pending;
  }
}

/** @type {Record<string, {wave: OscillatorType, gap: number, steps: Array<{frequency: number, length: number}>}>} */
const BLIPS = {
  select: { wave: 'square', gap: 0, steps: [{ frequency: 880, length: 0.05 }] },
  confirm: { wave: 'square', gap: 0.06, steps: [{ frequency: 660, length: 0.05 }, { frequency: 990, length: 0.09 }] },
  cancel: { wave: 'square', gap: 0.05, steps: [{ frequency: 520, length: 0.05 }, { frequency: 340, length: 0.08 }] },
  error: { wave: 'sawtooth', gap: 0.07, steps: [{ frequency: 220, length: 0.09 }, { frequency: 180, length: 0.12 }] },
  hit: { wave: 'square', gap: 0, steps: [{ frequency: 160, length: 0.1 }] },
  faint: { wave: 'triangle', gap: 0.08, steps: [{ frequency: 440, length: 0.1 }, { frequency: 220, length: 0.18 }] },
  catch: { wave: 'square', gap: 0.09, steps: [{ frequency: 660, length: 0.07 }, { frequency: 880, length: 0.07 }, { frequency: 1320, length: 0.16 }] },
};

/**
 * Map a General MIDI program onto one of the four voices the synth has.
 * @param {number} program
 */
function voiceFor(program) {
  if (program >= 128) return { wave: 'noise', gain: 0.5, transpose: 0, attack: 0.002, sustain: 0.2, release: 0.08 };
  if (program < 8) return { wave: 'triangle', gain: 0.5, transpose: 0, attack: 0.004, sustain: 0.55, release: 0.12 };
  if (program < 32) return { wave: 'square', gain: 0.32, transpose: 0, attack: 0.006, sustain: 0.6, release: 0.1 };
  if (program < 40) return { wave: 'sawtooth', gain: 0.42, transpose: -12, attack: 0.006, sustain: 0.7, release: 0.1 };
  if (program < 56) return { wave: 'sawtooth', gain: 0.26, transpose: 0, attack: 0.03, sustain: 0.8, release: 0.18 };
  if (program < 80) return { wave: 'square', gain: 0.3, transpose: 0, attack: 0.012, sustain: 0.75, release: 0.12 };
  if (program < 112) return { wave: 'sawtooth', gain: 0.24, transpose: 0, attack: 0.02, sustain: 0.7, release: 0.16 };
  return { wave: 'noise', gain: 0.4, transpose: 0, attack: 0.002, sustain: 0.3, release: 0.1 };
}

const midiToFrequency = (note) => 440 * 2 ** ((note - 69) / 12);

/** @param {AudioContext} context */
function createNoiseBuffer(context) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
