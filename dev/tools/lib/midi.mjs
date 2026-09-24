/**
 * Standard MIDI File parser.
 *
 * The decomp ships every track as an SMF under `sound/songs/midi/`. The game
 * does not want to run a full synthesiser over raw MIDI at runtime, so the
 * pipeline flattens each file here into absolute-time note events which
 * `src/renderer/core/audio.mjs` replays through WebAudio oscillators.
 */

/**
 * @typedef {Object} Note
 * @property {number} t   start time in seconds
 * @property {number} d   duration in seconds
 * @property {number} n   MIDI note number
 * @property {number} v   velocity 0..1
 */

/**
 * @typedef {Object} Track
 * @property {number} channel
 * @property {number} program General MIDI program number (0-127); 128 = drums
 * @property {Note[]} notes
 */

/**
 * @param {Buffer} buffer
 * @returns {{duration: number, loop?: number, tracks: Track[]}} `loop` is where
 *   a looping song's intro ends, in seconds, when the file marks one
 */
export function parseMidi(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'MThd') throw new Error('Not a MIDI file');
  const format = buffer.readUInt16BE(8);
  const trackCount = buffer.readUInt16BE(10);
  const division = buffer.readUInt16BE(12);
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');

  /** @type {Array<{tick: number, usPerQuarter: number}>} */
  const tempoMap = [{ tick: 0, usPerQuarter: 500000 }];
  /** @type {Array<{channel: number, program: number, notes: Array<{tick:number, endTick:number, n:number, v:number}>}>} */
  const rawTracks = [];
  /** Where the song loops back to, if the file marks it: see `loop` below. */
  const markers = { loopTick: -1 };

  let offset = 14;
  for (let index = 0; index < trackCount && offset < buffer.length; index++) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'MTrk') break;
    const length = buffer.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    parseTrack(buffer, offset + 8, end, tempoMap, rawTracks, markers);
    offset = end;
  }
  void format;

  tempoMap.sort((a, b) => a.tick - b.tick);
  const toSeconds = buildTickConverter(tempoMap, division);

  /** @type {Track[]} */
  const tracks = [];
  let duration = 0;
  for (const raw of rawTracks) {
    if (raw.notes.length === 0) continue;
    /** @type {Note[]} */
    const notes = raw.notes.map((note) => {
      const t = toSeconds(note.tick);
      const d = Math.max(0.02, toSeconds(note.endTick) - t);
      duration = Math.max(duration, t + d);
      return { t: round(t), d: round(d), n: note.n, v: round(note.v / 127) };
    });
    notes.sort((a, b) => a.t - b.t);
    tracks.push({ channel: raw.channel, program: raw.channel === 9 ? 128 : raw.program, notes });
  }

  // The decomp marks a looping song's loop with `[` and `]` markers: whatever
  // comes before the `[` is an intro that plays once. A victory theme is a
  // two-second fanfare and a long body looped under the experience screen,
  // and this is what lets a cue play the one without the other.
  const loop = markers.loopTick > 0 ? { loop: round(toSeconds(markers.loopTick)) } : {};
  return { duration: round(duration), ...loop, tracks };
}

const round = (value) => Math.round(value * 1000) / 1000;

function parseTrack(buffer, start, end, tempoMap, rawTracks, markers) {
  let pos = start;
  let tick = 0;
  let runningStatus = 0;

  /** @type {Map<number, {channel:number, program:number, notes:any[]}>} */
  const byChannel = new Map();
  /** @type {Map<number, {tick:number, endTick:number, n:number, v:number}[]>} */
  const sounding = new Map();

  const channelTrack = (channel) => {
    let track = byChannel.get(channel);
    if (!track) {
      track = { channel, program: 0, notes: [] };
      byChannel.set(channel, track);
      rawTracks.push(track);
    }
    return track;
  };

  while (pos < end) {
    const delta = readVarInt(buffer, pos);
    pos = delta.next;
    tick += delta.value;

    let status = buffer[pos];
    if (status < 0x80) {
      status = runningStatus;
    } else {
      pos++;
      if (status < 0xf0) runningStatus = status;
    }

    if (status === 0xff) {
      const type = buffer[pos++];
      const length = readVarInt(buffer, pos);
      pos = length.next;
      if (type === 0x51) {
        tempoMap.push({ tick, usPerQuarter: (buffer[pos] << 16) | (buffer[pos + 1] << 8) | buffer[pos + 2] });
      }
      if (type === 0x06 && markers.loopTick < 0 && buffer.toString('ascii', pos, pos + length.value) === '[') {
        markers.loopTick = tick;
      }
      pos += length.value;
      if (type === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = readVarInt(buffer, pos);
      pos = length.next + length.value;
      continue;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;

    if (command === 0xc0) {
      channelTrack(channel).program = buffer[pos++];
      continue;
    }
    if (command === 0xd0) {
      pos++;
      continue;
    }

    const data1 = buffer[pos++];
    const data2 = buffer[pos++];

    if (command === 0x90 && data2 > 0) {
      const note = { tick, endTick: tick, n: data1, v: data2 };
      channelTrack(channel).notes.push(note);
      const key = channel * 128 + data1;
      const stack = sounding.get(key) ?? [];
      stack.push(note);
      sounding.set(key, stack);
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      const key = channel * 128 + data1;
      const stack = sounding.get(key);
      const note = stack?.shift();
      if (note) note.endTick = tick;
    }
  }

  // Anything still held at end-of-track ends there.
  for (const stack of sounding.values()) {
    for (const note of stack) if (note.endTick === note.tick) note.endTick = tick;
  }
}

/**
 * @param {Array<{tick: number, usPerQuarter: number}>} tempoMap
 * @param {number} ticksPerQuarter
 */
function buildTickConverter(tempoMap, ticksPerQuarter) {
  // Precompute the elapsed seconds at each tempo change so lookups are O(log n).
  const points = [{ tick: 0, seconds: 0, usPerQuarter: tempoMap[0].usPerQuarter }];
  for (let i = 1; i < tempoMap.length; i++) {
    const previous = points[points.length - 1];
    const deltaTicks = tempoMap[i].tick - previous.tick;
    const seconds = previous.seconds + (deltaTicks * previous.usPerQuarter) / (ticksPerQuarter * 1e6);
    points.push({ tick: tempoMap[i].tick, seconds, usPerQuarter: tempoMap[i].usPerQuarter });
  }

  return (tick) => {
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (points[mid].tick <= tick) low = mid;
      else high = mid - 1;
    }
    const point = points[low];
    return point.seconds + ((tick - point.tick) * point.usPerQuarter) / (ticksPerQuarter * 1e6);
  };
}

function readVarInt(buffer, pos) {
  let value = 0;
  let byte;
  do {
    byte = buffer[pos++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, next: pos };
}
