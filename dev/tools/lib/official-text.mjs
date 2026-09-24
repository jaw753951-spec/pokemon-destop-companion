/**
 * The newest official Korean text, laid over what PokeAPI publishes.
 *
 * PokeAPI's Korean text stops where its contributors stopped: the Paldea
 * Pokédex entries, the Gen 9 abilities' descriptions and a few new names are
 * missing, and some move names are spelled the way an older game spelled them
 * (a Brick Break was 깨뜨리다 before Scarlet and Violet made it 깨트리기).
 * Two public dumps of the games' own text fill that in:
 *
 * - Scarlet/Violet's message archive (`Pokemon-Project-com/sv-text`), every
 *   language side by side, one line per entry. Moves and abilities are filed
 *   by their national number; items, Pokémon and Pokédex entries in the
 *   game's own order, so those are lined up through the English side.
 * - Pokémon GO's translation table (`PokeMiners/pogo_assets`), which carries
 *   the Legends: Arceus Pokédex entries for the Hisuian Pokémon that
 *   Scarlet/Violet 1.0 did not yet have.
 *
 * A line is only taken when its English side agrees with PokeAPI's English
 * for the same thing — so a dump that numbers something differently, or a
 * placeholder the game ships for content it has not unlocked yet, changes
 * nothing.
 */
import { fetchBuffer, fetchJson } from './http.mjs';

const SV_TEXT = 'https://raw.githubusercontent.com/Pokemon-Project-com/sv-text/main/common';
const GO_TEXT = 'https://raw.githubusercontent.com/PokeMiners/pogo_assets/master/Texts/Latest%20APK/JSON';

/**
 * @param {string} text the whole of a `common_xxx.txt`
 * @returns {Record<string, string[]>} each file's lines, by file name
 */
function parseArchive(text) {
  /** @type {Record<string, string[]>} */
  const out = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^Text File : (.+)$/.exec(line);
    if (header) {
      current = header[1].trim();
      out[current] = [];
      continue;
    }
    if (line.startsWith('~~~~~~~~') || current === null) continue;
    out[current].push(line.replace(/\r$/, ''));
  }
  return out;
}

/** A game line as a sentence: its manual line breaks become spaces. */
const sentence = (line) =>
  line
    .replace(/\\n/g, ' ')
    .replace(/\\c/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** What two English strings are compared by. */
const key = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/é/g, 'e')
    .replace(/♀/g, 'f')
    .replace(/♂/g, 'm')
    .replace(/[^a-z0-9]/g, '');

/** A line fit to show: filled in, no unresolved variables, no placeholder. */
const usable = (line) =>
  Boolean(line && /[가-힣]/.test(line) && !line.includes('[VAR') && !/^\[~ \d+\]$/.test(line.trim()));

/** An English line fit to line things up by. */
const usableEnglish = (line) => Boolean(line && /[A-Za-z]/.test(line) && !/^\[~ \d+\]$/.test(line.trim()));

/**
 * @param {{species: Record<string, any>, moves: Record<string, any>, abilities: Record<string, any>, items: Record<string, any>}} data
 * @param {(message: string) => void} log
 */
export async function layOfficialKorean({ species, moves, abilities, items }, log) {
  const [korean, english] = await Promise.all([
    fetchBuffer(`${SV_TEXT}/common_kor.txt`, { allowMissing: true }),
    fetchBuffer(`${SV_TEXT}/common_eng.txt`, { allowMissing: true }),
  ]);
  const counts = { names: 0, moveText: 0, abilityText: 0, itemText: 0, dex: 0, goDex: 0 };

  if (korean && english) {
    const ko = parseArchive(korean.toString('utf8'));
    const en = parseArchive(english.toString('utf8'));

    // Moves and abilities by number, where the English agrees.
    const byNumber = (records, nameFile, infoFile, textCount) => {
      for (const record of Object.values(records)) {
        const index = record.id;
        if (key(en[nameFile]?.[index]) !== key(record.name?.en)) continue;
        const name = ko[nameFile]?.[index]?.trim();
        if (usable(name) && name !== record.name.ko) {
          record.name = { ...record.name, ko: name };
          counts.names++;
        }
        const info = ko[infoFile]?.[index];
        if (usable(info)) {
          const text = sentence(info);
          if (text !== record.text?.ko) {
            record.text = { ...(record.text ?? {}), ko: text };
            counts[textCount]++;
          }
        }
      }
    };
    byNumber(moves, 'wazaname.dat', 'wazainfo.dat', 'moveText');
    byNumber(abilities, 'tokusei.dat', 'tokuseiinfo.dat', 'abilityText');

    // Items by their English name.
    /** @type {Map<string, number>} */
    const itemIndex = new Map();
    (en['itemname.dat'] ?? []).forEach((name, index) => {
      if (usableEnglish(name) && !itemIndex.has(key(name))) itemIndex.set(key(name), index);
    });
    for (const item of Object.values(items)) {
      // A machine is described by the move it teaches, and its own line in
      // the archive is a placeholder.
      if (item.pocket === 'machines') continue;
      const index = itemIndex.get(key(item.name?.en));
      if (index === undefined) continue;
      const name = ko['itemname.dat']?.[index]?.trim();
      if (usable(name) && name !== item.name.ko) {
        item.name = { ...item.name, ko: name };
        counts.names++;
      }
      const info = ko['iteminfo.dat']?.[index];
      if (usable(info) && sentence(info) !== item.text?.ko) {
        item.text = { ...(item.text ?? {}), ko: sentence(info) };
        counts.itemText++;
      }
    }

    // Pokédex entries by their English text: Scarlet's, then Violet's.
    /** @type {Map<string, string>} */
    const entries = new Map();
    for (const file of ['zukan_comment_A.dat', 'zukan_comment_B.dat']) {
      (en[file] ?? []).forEach((line, index) => {
        const translated = ko[file]?.[index];
        if (usableEnglish(line) && usable(translated) && !entries.has(key(sentence(line)))) {
          entries.set(key(sentence(line)), sentence(translated));
        }
      });
    }
    for (const entry of Object.values(species)) {
      if (/[가-힣]/.test(entry.text?.ko ?? '')) continue;
      const found = entries.get(key(entry.text?.en));
      if (!found) continue;
      entry.text = { ...(entry.text ?? {}), ko: found };
      counts.dex++;
    }
  } else {
    log('official text unavailable — the Scarlet/Violet archive could not be read');
  }

  // What is still missing, from Pokémon GO's table, which carries the Legends:
  // Arceus entries word for word.
  const [goKorean, goEnglish] = await Promise.all([
    fetchJson(`${GO_TEXT}/i18n_korean.json`, { allowMissing: true }),
    fetchJson(`${GO_TEXT}/i18n_english.json`, { allowMissing: true }),
  ]);
  if (goKorean?.data && goEnglish?.data) {
    const table = (list) => {
      /** @type {Map<string, string>} */
      const out = new Map();
      for (let index = 0; index + 1 < list.length; index += 2) out.set(list[index], list[index + 1]);
      return out;
    };
    const goKo = table(goKorean.data);
    const goEn = table(goEnglish.data);
    for (const entry of Object.values(species)) {
      if (/[가-힣]/.test(entry.text?.ko ?? '')) continue;
      const id = `pokemon_desc_${String(entry.dex ?? entry.id).padStart(4, '0')}`;
      if (!goKo.has(id) || key(goEn.get(id)) !== key(entry.text?.en)) continue;
      entry.text = { ...(entry.text ?? {}), ko: sentence(goKo.get(id)) };
      counts.goDex++;
    }
  }

  log(
    `official Korean: ${counts.names} names, ${counts.moveText} move and ${counts.abilityText} ability descriptions, ` +
      `${counts.itemText} item descriptions, ${counts.dex + counts.goDex} Pokédex entries (${counts.goDex} from GO)`,
  );
}
