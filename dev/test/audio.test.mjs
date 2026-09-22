/**
 * The sound engine's own bookkeeping: which track is playing, and what a cue
 * does to it.
 *
 * The synthesiser itself needs a Web Audio context and a window timer, so both
 * are stubbed here — nothing below listens to the result, only to which song
 * the engine decided should be sounding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** A song the scheduler can run: one track, one note, half a second long. */
const SONG = { duration: 0.5, tracks: [{ program: 0, notes: [{ t: 0, d: 0.1, n: 60, v: 0.5 }] }] };

/** The timers the engine schedules on, driven by hand. */
const timers = new Map();
let nextTimer = 1;
let now = 0;

/** Every Web Audio node the engine touches, reduced to what it calls on them. */
const node = () => ({
  connect() {},
  disconnect() {},
  start() {},
  stop() {},
  gain: { setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
  frequency: { value: 0 },
  Q: { value: 0 },
  type: '',
  buffer: null,
  loop: false,
  getChannelData: () => new Float32Array(1),
  onended: null,
});

globalThis.AudioContext = /** @type {any} */ (function AudioContextStub() {
  return {
    get currentTime() {
      return now;
    },
    destination: node(),
    sampleRate: 100,
    createGain: node,
    createOscillator: node,
    createBufferSource: node,
    createBiquadFilter: node,
    createBuffer: node,
  };
});

globalThis.window = /** @type {any} */ ({
  setInterval: (fn) => {
    const id = nextTimer++;
    timers.set(id, fn);
    return id;
  },
  clearInterval: (id) => timers.delete(id),
});

globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => SONG }));

const { AudioEngine } = await import('../../app/renderer/core/audio.mjs');

/** Run every scheduled tick once, the way the browser's timers would. */
const tick = (seconds = 0) => {
  now += seconds;
  for (const fn of [...timers.values()]) fn();
};

/** Let the engine's own promises — loading a song — finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a cue silences the music and hands it back when it ends', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  assert.equal(audio.current?.name, 'route');

  // The fanfare takes the speaker: the battle theme and a victory jingle
  // playing over each other was the whole complaint.
  await audio.playJingle('victory');
  assert.equal(audio.jingle?.name, 'victory');
  assert.equal(audio.current, null);
  assert.equal(audio.wanted, 'route');

  // Past the end of the cue, the music comes back on its own.
  tick(2);
  await settle();
  assert.equal(audio.jingle, null);
  assert.equal(audio.current?.name, 'route');
});

test('a track asked for during a cue is the one that comes back', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('battle');
  await audio.playJingle('victory');

  // Leaving a battle asks for the area's music while the fanfare is still
  // going; it must not start underneath the cue, and it must not be lost.
  await audio.playMusic('route');
  assert.equal(audio.current, null);
  assert.equal(audio.wanted, 'route');

  tick(2);
  await settle();
  assert.equal(audio.current?.name, 'route');
});

test('asking for the track already playing changes nothing', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  const playing = audio.current;
  await audio.playMusic('route');
  assert.equal(audio.current, playing);
});

test('stopping the music leaves nothing waiting to come back', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  await audio.playMusic(null);
  assert.equal(audio.current, null);
  assert.equal(audio.wanted, null);

  tick(2);
  assert.equal(audio.current, null);
});

test('a cue can be cut to its opening phrase', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  // The stub song is half a second long; ask for a fifth of it.
  await audio.playJingle('victory', { seconds: 0.1 });
  assert.equal(audio.jingle?.limit, 0.1);

  // It is over — and the music back — well before the whole song would have
  // finished, which is the point of cutting it.
  now += 0.6;
  tick();
  await settle();
  assert.equal(audio.jingle, null);
  assert.equal(audio.current?.name, 'route');
});

test('a cue is never stretched past the song it came from', async () => {
  const audio = new AudioEngine();
  await audio.playJingle('victory', { seconds: 30 });
  assert.equal(audio.jingle?.limit, 0.5);
});

test('cues play on the music channel, where the music slider reaches them', async () => {
  const audio = new AudioEngine();
  const voiced = [];
  audio.playNote = (program, note, when, output) => voiced.push(output);

  await audio.playJingle('victory');
  assert.ok(voiced.length > 0, 'the cue should have voiced something');
  for (const output of voiced) assert.equal(output, audio.musicGain);
});
