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
    /** @type {GainNode|null} */
    this.cryGain = null;
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
    this.cryVolume = 0.9;

    /** @type {{name: string, song: any, startedAt: number, cursors: number[]}|null} */
    this.jingle = null;
    /** @type {number|undefined} */
    this.jingleTimer = undefined;

    /**
     * The track the game wants playing under everything else.
     *
     * Kept apart from `current`, which is only what the note scheduler happens
     * to be running: a cue silences the music while it plays, and this is what
     * comes back afterwards. It is also set the moment `playMusic` is called
     * rather than after the song has loaded, so a cue started in the same
     * frame as a track change resumes the new track and not the old one.
     * @type {string|null}
     */
    this.wanted = null;
  }

  /** Create the audio graph. Safe to call more than once. */
  start() {
    if (this.context) return;
    this.context = new AudioContext();
    this.musicGain = this.context.createGain();
    this.effectGain = this.context.createGain();
    this.cryGain = this.context.createGain();
    this.musicGain.connect(this.context.destination);
    this.effectGain.connect(this.context.destination);
    this.cryGain.connect(this.context.destination);
    this.applyVolumes();
    this.noise = createNoiseBuffer(this.context);
  }

  /**
   * @param {{musicVolume?: number, effectVolume?: number, cryVolume?: number}} volumes
   */
  setVolumes({ musicVolume, effectVolume, cryVolume }) {
    if (typeof musicVolume === 'number') this.musicVolume = musicVolume;
    if (typeof effectVolume === 'number') this.effectVolume = effectVolume;
    if (typeof cryVolume === 'number') this.cryVolume = cryVolume;
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.context || !this.musicGain || !this.effectGain || !this.cryGain) return;
    const now = this.context.currentTime;
    // Music is mixed low: it plays under whatever the user is actually doing.
    this.musicGain.gain.setTargetAtTime(this.musicVolume * 0.22, now, 0.05);
    this.effectGain.gain.setTargetAtTime(this.effectVolume * 0.5, now, 0.05);
    this.cryGain.gain.setTargetAtTime(this.cryVolume * 0.6, now, 0.05);
  }

  /**
   * Play a track from `assets/bgm`, looping until something else is asked for.
   * @param {string|null} name
   */
  async playMusic(name) {
    if (!name) return this.stopMusic();
    this.start();
    // Recorded before anything is awaited, so whatever else happens in this
    // frame — a victory fanfare, a second track change — agrees on what the
    // music is meant to be.
    this.wanted = name;
    // A cue owns the speaker while it plays; this track comes back under it
    // when the cue finishes rather than starting underneath it now.
    if (this.jingle) return;
    if (this.current?.name === name) return;

    let song;
    try {
      song = await this.loadSong(name);
    } catch {
      return; // a missing track is silence, not a broken game
    }
    // Something asked for a different track, or a cue started, while this one
    // was loading.
    if (!this.context || this.wanted !== name || this.jingle) return;

    this.haltMusic();
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

  /**
   * Play one of the short cue tracks — the fanfares, the heal chime — once,
   * on the effects channel.
   *
   * These are sound effects that happen to be stored as MIDI: the cartridge
   * stops the area music, plays the jingle, and resumes. Looping them through
   * `playMusic` made the heal chime repeat forever, and replaced the area
   * music with two seconds of silence afterwards.
   *
   * Playing one *over* the music was no better — a victory fanfare and the
   * battle theme in two keys at once — so the music stands down for the cue
   * and `wanted` brings it back at the end, which is what the cartridge does.
   *
   * Scheduling reuses the music machinery, but on a private `current` that
   * clears itself at the end of the song instead of looping.
   *
   * @param {string|null} name
   */
  async playJingle(name) {
    if (!name) return;
    this.start();
    if (!this.context) return;
    if (this.jingle?.name === name) return; // already playing this one

    let song;
    try {
      song = await this.loadSong(name);
    } catch {
      return; // a missing cue is not worth a console error, let alone a break
    }
    if (!this.context || !this.effectGain) return;

    // The music steps aside for the cue; `wanted` still names it, so the end
    // of the cue puts it back.
    this.haltMusic();

    const jingle = {
      name,
      song,
      startedAt: this.context.currentTime + 0.05,
      cursors: song.tracks.map(() => 0),
    };
    if (this.jingleTimer !== undefined) window.clearInterval(this.jingleTimer);
    this.jingle = jingle;
    this.jingleTimer = window.setInterval(() => this.scheduleJingle(), TICK_MS);
    this.scheduleJingle();
  }

  /**
   * Queue the jingle's notes once through, then stop scheduling and hand the
   * speaker back to the music.
   */
  scheduleJingle() {
    const jingle = this.jingle;
    if (!jingle || !this.context || !this.effectGain) return;
    const { song, cursors } = jingle;
    const horizon = this.context.currentTime + LOOKAHEAD_S;
    const end = jingle.startedAt + song.duration;
    let started = 0;

    // One pass is the whole cue: it is played once and never looped, so the
    // cursors run to the end of each track and stay there.
    song.tracks.forEach((track, index) => {
      while (cursors[index] < track.notes.length && started < MAX_NOTES_PER_TICK) {
        const note = track.notes[cursors[index]];
        const when = jingle.startedAt + note.t;
        if (when > horizon) return;
        this.playNote(track.program, note, Math.max(when, this.context.currentTime), this.effectGain);
        cursors[index]++;
        started++;
      }
    });

    if (this.context.currentTime <= end + 0.2) return;

    this.stopJingle();
    // Whatever the game asked for while the cue held the speaker — or was
    // playing before it started — comes back now.
    if (this.wanted) void this.playMusic(this.wanted);
  }

  /** Stop the note scheduler, leaving `wanted` — and any cue — alone. */
  haltMusic() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.current = null;
  }

  /** Stop a cue that is playing, without resuming anything. */
  stopJingle() {
    if (this.jingleTimer !== undefined) window.clearInterval(this.jingleTimer);
    this.jingleTimer = undefined;
    this.jingle = null;
  }

  /** Silence for good: no track playing, and none waiting to come back. */
  stopMusic() {
    this.wanted = null;
    this.haltMusic();
    this.stopJingle();
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
   * @param {GainNode|null} [output] the channel to voice it on; the music by
   *   default, the effects channel for the cues, so the sound tab's three
   *   sliders each control what their label says they do
   */
  playNote(program, note, when, output = null) {
    if (!this.context || !this.musicGain) return;
    const sink = output ?? this.musicGain;
    const voice = voiceFor(program);
    const duration = Math.min(note.d, 4);
    const gain = this.context.createGain();
    gain.connect(sink);

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
   *
   * Cries ride their own gain node so the sound tab can turn them down — or
   * off — without touching the effects they share a speaker with.
   *
   * @param {number} speciesId
   */
  async playCry(speciesId) {
    await this.playSample(`cries/${speciesId}.ogg`, this.cryGain);
  }

  /**
   * @param {string} path
   * @param {GainNode|null} [output] the channel to voice it on, effects by default
   */
  async playSample(path, output = null) {
    this.start();
    if (!this.context) return;
    const sink = output ?? this.effectGain;
    if (!sink) return;
    try {
      let pending = this.buffers.get(path);
      if (!pending) {
        pending = loadAudioBuffer(this.context, path);
        this.buffers.set(path, pending);
      }
      const source = this.context.createBufferSource();
      source.buffer = await pending;
      source.connect(sink);
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
