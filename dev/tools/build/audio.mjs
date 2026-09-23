/**
 * Convert the decompilation's MIDI soundtrack into note-event JSON.
 *
 * The game does not ship a sampled instrument bank — the renderer plays these
 * events on a small WebAudio synth (see `src/renderer/core/audio.mjs`), which
 * keeps the download tiny and suits the GBA-era material.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { parseMidi } from '../lib/midi.mjs';
import { EMERALD } from '../sources.mjs';

/**
 * Tracks the game needs beyond the per-area music, keyed by the role the game
 * asks for rather than by the cartridge's own constant names.
 */
export const CUES = {
  title: 'mus_littleroot',
  battleWild: 'mus_vs_wild',
  battleTrainer: 'mus_vs_trainer',
  battleLeader: 'mus_vs_gym_leader',
  battleEliteFour: 'mus_vs_elite_four',
  battleChampion: 'mus_vs_champion',
  // The cartridge's victory themes are a two-second fanfare that runs straight
  // into a loop scored to hold the screen while experience is shared out —
  // sixteen seconds of it here, with the road waiting. Cutting at the loop
  // stops them mid-phrase, so the wins borrow short fanfares that end on
  // their own: the game corner's win jingle and the Battle Frontier's.
  victoryWild: 'mus_slots_win',
  victoryTrainer: 'mus_obtain_b_points',
  victoryLeader: 'mus_victory_gym_leader',
  victoryLeague: 'mus_victory_league',
  league: 'mus_victory_road',
  encounterTrainer: 'mus_encounter_male',
  encounterLeader: 'mus_encounter_cool',
  encounterChampion: 'mus_encounter_champion',
  heal: 'mus_heal',
  levelUp: 'mus_level_up',
  evolution: 'mus_evolution',
  evolved: 'mus_evolved',
  caught: 'mus_caught',
  obtainItem: 'mus_obtain_item',
  obtainBerry: 'mus_obtain_berry',
  obtainTm: 'mus_obtain_tmhm',
  obtainBadge: 'mus_obtain_badge',
};

/**
 * Maps a map's music constant to a real track where the cartridge used a
 * sentinel instead. Route 118 picks its theme at runtime from which half of
 * the map the player stands on; we use the eastern half's track.
 */
const MUSIC_ALIASES = { mus_route118: 'mus_route119' };

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildAudio({ assetDir, dataDir, log, pool }) {
  /** @type {Array<{id: string, music: string|null}>} */
  const areas = JSON.parse(await readFile(join(dataDir, 'areas.json'), 'utf8'));
  for (const area of areas) {
    if (area.music && MUSIC_ALIASES[area.music]) area.music = MUSIC_ALIASES[area.music];
  }

  const wanted = new Set([
    ...areas.map((area) => area.music).filter(Boolean),
    ...Object.values(CUES),
  ]);

  /** @type {Record<string, {duration: number, tracks: number, notes: number}>} */
  const built = {};
  const missing = [];

  await Promise.all(
    [...wanted].map((name) =>
      pool(async () => {
        const source = await fetchBuffer(`${EMERALD}/sound/songs/midi/${name}.mid`, { allowMissing: true });
        if (!source) {
          missing.push(name);
          return;
        }
        const song = parseMidi(source);
        if (song.tracks.length === 0) {
          missing.push(name);
          return;
        }
        await writeOut(join(assetDir, 'bgm', `${name}.json`), JSON.stringify(song));
        built[name] = {
          duration: song.duration,
          tracks: song.tracks.length,
          notes: song.tracks.reduce((sum, track) => sum + track.notes.length, 0),
        };
      }),
    ),
  );

  // Cues whose track is missing fall back to one that exists, so the game never
  // asks the audio layer for a file that was never written.
  /** @type {Record<string, string>} */
  const cues = {};
  for (const [role, name] of Object.entries(CUES)) {
    cues[role] = built[name] ? name : Object.keys(built)[0] ?? null;
  }

  // Same for areas: an area must never name a track the audio layer cannot load.
  const areaFallback = areas.find((area) => area.music && built[area.music])?.music ?? null;
  for (const area of areas) {
    if (area.music && !built[area.music]) area.music = areaFallback;
  }
  await writeOut(join(dataDir, 'areas.json'), JSON.stringify(areas));

  await writeOut(join(dataDir, 'bgm.json'), JSON.stringify({ cues, tracks: built }));
  log(`bgm ${Object.keys(built).length}/${wanted.size} tracks`);
  if (missing.length) log(`  missing: ${missing.join(', ')}`);
  return built;
}
