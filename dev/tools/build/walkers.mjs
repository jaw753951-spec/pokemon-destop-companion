/**
 * The Pokémon as they walk the road: a walking strip and a standing strip per
 * species, from the PMD Sprite Collab.
 *
 * The field used to walk every Pokémon in its box icon, scaled to a height
 * worked out from the Pokédex. The icons are not drawn to a common size, so
 * every species came out at its own fractional scale and no two were made of
 * the same size of pixel — and there are no icons at all past Calyrex, so the
 * newest species walked in a model render at another density again. The
 * Sprite Collab draws the whole dex at one density, sized to the Pokémon, with
 * real walking frames; drawn at one scale, every Pokémon on the road is made
 * of the same pixels.
 *
 * Each sheet is eight rows, one per direction, of equal frames. The row facing
 * right is the one the companion walks the road in; anything facing left is
 * that row mirrored. Frames are cropped to one box shared by the whole strip,
 * centred on the frame the way the sheets centre their Pokémon, so the feet
 * stay planted as the frames change and a Pokémon does not step sideways when
 * it stops walking and starts standing.
 *
 * The shiny art is its own sheet. Species the collab has not drawn keep their
 * box icon, which the renderer falls back to on its own.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { fetchBuffer, fetchJson, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { concatX, crop, opaqueBounds } from '../lib/image.mjs';
import { MAX_SPECIES, SPRITE_COLLAB } from '../sources.mjs';

/** The sheets' rows run clockwise from facing the viewer; this one faces right. */
const FACING_RIGHT = 2;

/** And this one looks down and to the left: the three-quarter view a box icon is drawn in. */
const FACING_DOWN_LEFT = 7;

/**
 * The last species the published box icons reach. Past it the sprites step
 * falls back to a model render for the icon — the only picture there is — so
 * the Sprite Collab's own standing frame stands in, turned the way a box icon
 * faces, and the box, the dex and the tray show the Pokémon in the art it
 * walks in rather than in a render at another density.
 */
const LAST_BOX_ICON = 898;

/** The collab times its frames in the handheld's frames, sixty to the second. */
const TICK_MS = 1000 / 60;

/** The two animations the game draws a Pokémon walking and standing in. */
const POSES = [
  { key: 'walk', anim: 'Walk' },
  { key: 'idle', anim: 'Idle' },
];

/**
 * @param {{assetDir: string, dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildWalkers({ assetDir, dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;
  const tracker = await fetchJson(`${SPRITE_COLLAB}/tracker.json`);
  const names = creditNames((await fetchBuffer(`${SPRITE_COLLAB}/credit_names.txt`))?.toString('utf8') ?? '');

  const manifestPath = join(dataDir, 'sprites.json');
  /** @type {Record<string, any>} */
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  /** @type {Set<string>} */
  const artists = new Set();
  const missing = [];

  await Promise.all(
    Array.from({ length: limit }, (_, index) => index + 1).map((id) =>
      pool(async () => {
        const entry = manifest[id] ?? (manifest[id] = { shiny: {} });
        entry.shiny ??= {};
        for (const pose of POSES) {
          delete entry[pose.key];
          delete entry.shiny[pose.key];
        }

        const key = String(id).padStart(4, '0');
        const record = tracker?.[key];
        // The tracker lists a sheet by name whether or not it is locked, and
        // the value is only the lock: `Walk: false` is a walk that exists.
        if (!hasSheet(record, 'Walk')) {
          missing.push(id);
          return;
        }

        const shinyRecord = record.subgroups?.['0000']?.subgroups?.['0001'];
        const variants = [
          { suffix: '', into: entry, base: `${SPRITE_COLLAB}/sprite/${key}`, record },
          ...(hasSheet(shinyRecord, 'Walk')
            ? [{ suffix: '-shiny', into: entry.shiny, base: `${SPRITE_COLLAB}/sprite/${key}/0000/0001`, record: shinyRecord }]
            : []),
        ];

        /** Which palettes got an icon from the collab, past the box icons' reach. */
        const iconed = new Set();
        for (const variant of variants) {
          const anims = parseAnimData((await fetchBuffer(`${variant.base}/AnimData.xml`, { allowMissing: true }))?.toString('utf8'));
          let built = false;
          for (const pose of POSES) {
            const strip = await buildStrip(variant.base, anims, pose.anim);
            if (!strip) continue;
            await writeOut(join(assetDir, 'pokemon', String(id), `${pose.key}${variant.suffix}.png`), strip.png);
            variant.into[pose.key] = strip.meta;
            built = true;
          }
          if (id > LAST_BOX_ICON) {
            const icon = await buildIcon(variant.base, anims);
            if (icon) {
              await writeOut(join(assetDir, 'pokemon', String(id), `icon${variant.suffix}.png`), icon.png);
              variant.into.icon = icon.meta;
              iconed.add(variant.suffix);
              built = true;
            }
          }
          if (built) for (const name of creditsOf(variant.record, names)) artists.add(name);
        }
        // A shiny icon left over from the render would be the one picture in
        // the box at another density; the ordinary colours in the right art
        // are the better miss.
        if (iconed.has('') && !iconed.has('-shiny')) delete entry.shiny.icon;
        if (!entry.walk) missing.push(id);
      }),
    ),
  );

  await writeOut(manifestPath, JSON.stringify(manifest));
  await writeOut(
    join(dataDir, 'credits.json'),
    JSON.stringify({
      sprites: {
        source: 'PMD Sprite Collab',
        url: 'https://sprites.pmdcollab.org/',
        license: 'CC BY-NC 4.0',
        artists: [...artists].sort((a, b) => a.localeCompare(b)),
      },
    }),
  );

  const walking = Object.values(manifest).filter((entry) => entry.walk).length;
  const shiny = Object.values(manifest).filter((entry) => entry.shiny?.walk).length;
  log(`walkers ${walking}/${limit} (${shiny} with shiny art), ${artists.size} artists credited`);
  if (missing.length) {
    log(`  on their box icon: ${missing.length} (${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''})`);
  }
}

/**
 * The animations a sheet set declares, by name: frame size and timings, or
 * the animation it borrows its frames from.
 *
 * @param {string|undefined} xml
 * @returns {Map<string, {width: number, height: number, durations: number[], copyOf: string|null}>}
 */
export function parseAnimData(xml) {
  const anims = new Map();
  for (const [, body] of (xml ?? '').matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)) {
    const name = body.match(/<Name>([^<]+)<\/Name>/)?.[1];
    if (!name) continue;
    anims.set(name, {
      width: Number(body.match(/<FrameWidth>(\d+)<\/FrameWidth>/)?.[1] ?? 0),
      height: Number(body.match(/<FrameHeight>(\d+)<\/FrameHeight>/)?.[1] ?? 0),
      durations: [...body.matchAll(/<Duration>(\d+)<\/Duration>/g)].map((match) => Number(match[1])),
      copyOf: body.match(/<CopyOf>([^<]+)<\/CopyOf>/)?.[1] ?? null,
    });
  }
  return anims;
}

/**
 * One animation's right-facing row as a strip of equal frames.
 *
 * @param {string} base the sheet set's directory
 * @param {ReturnType<typeof parseAnimData>} anims
 * @param {string} name
 */
async function buildStrip(base, anims, name) {
  let anim = anims.get(name);
  let file = name;
  // An animation can be declared as another's frames under a new name.
  for (let hops = 0; anim?.copyOf && hops < 4; hops++) {
    file = anim.copyOf;
    anim = anims.get(anim.copyOf);
  }
  if (!anim || !anim.width || !anim.height) return null;

  const source = await fetchBuffer(`${base}/${file}-Anim.png`, { allowMissing: true });
  if (!source) return null;
  const sheet = decodePng(source);
  const count = Math.floor(sheet.width / anim.width);
  if (count === 0 || sheet.height < (FACING_RIGHT + 1) * anim.height) return null;

  const frames = Array.from({ length: count }, (_, index) =>
    crop(sheet, index * anim.width, FACING_RIGHT * anim.height, anim.width, anim.height),
  );
  const box = sharedBox(frames);
  if (!box) return null;
  const strip = concatX(frames.map((frame) => crop(frame, box.x, box.y, box.width, box.height)));

  const durations = frames.map((_, index) => Math.round((anim.durations[index] ?? anim.durations[0] ?? 8) * TICK_MS));
  return {
    png: encodePng(strip.width, strip.height, strip.data),
    meta: {
      width: box.width,
      height: box.height,
      frames: count,
      durations,
      delay: Math.round(durations.reduce((sum, value) => sum + value, 0) / count),
    },
  };
}

/**
 * A box icon made from the first standing frame, facing the way box icons do,
 * trimmed to the Pokémon.
 *
 * @param {string} base
 * @param {ReturnType<typeof parseAnimData>} anims
 */
async function buildIcon(base, anims) {
  for (const name of ['Idle', 'Walk']) {
    let anim = anims.get(name);
    let file = name;
    for (let hops = 0; anim?.copyOf && hops < 4; hops++) {
      file = anim.copyOf;
      anim = anims.get(anim.copyOf);
    }
    if (!anim || !anim.width || !anim.height) continue;
    const source = await fetchBuffer(`${base}/${file}-Anim.png`, { allowMissing: true });
    if (!source) continue;
    const sheet = decodePng(source);
    if (sheet.height < (FACING_DOWN_LEFT + 1) * anim.height) continue;
    const frame = crop(sheet, 0, FACING_DOWN_LEFT * anim.height, anim.width, anim.height);
    const bounds = opaqueBounds(frame);
    if (!bounds) continue;
    const icon = crop(frame, bounds.x, bounds.y, bounds.width, bounds.height);
    return { png: encodePng(icon.width, icon.height, icon.data), meta: { width: icon.width, height: icon.height } };
  }
  return null;
}

/**
 * The box every frame fits in: down to the lowest foot, up to the highest
 * point, and as wide either side of the frame's centre as the widest reach.
 *
 * @param {Array<import('../lib/image.mjs').Raster>} frames
 */
export function sharedBox(frames) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const frame of frames) {
    const bounds = opaqueBounds(frame);
    if (!bounds) continue;
    left = Math.min(left, bounds.x);
    right = Math.max(right, bounds.x + bounds.width);
    top = Math.min(top, bounds.y);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  if (!Number.isFinite(left)) return null;

  const width = frames[0].width;
  const centre = width / 2;
  const reach = Math.ceil(Math.max(centre - left, right - centre));
  const x = Math.max(0, Math.floor(centre - reach));
  return { x, y: top, width: Math.min(width, Math.ceil(centre + reach)) - x, height: bottom - top };
}

/**
 * @param {any} record a tracker entry
 * @param {string} name
 */
const hasSheet = (record, name) => Boolean(record?.sprite_files && name in record.sprite_files);

/**
 * The collab's credit list, from the handle a sprite is credited to to the
 * name its artist goes by.
 *
 * @param {string} text tab-separated: name, handle, contact
 * @returns {Map<string, string>}
 */
function creditNames(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [name, handle] = line.split('\t');
    if (name && handle) names.set(handle.trim(), name.trim());
  }
  return names;
}

/**
 * Everyone a sheet set is credited to, by name.
 *
 * @param {any} record the tracker's entry for the set
 * @param {Map<string, string>} names
 * @returns {string[]}
 */
function creditsOf(record, names) {
  const credit = record?.sprite_credit ?? {};
  return [credit.primary, ...(credit.secondary ?? [])]
    .filter(Boolean)
    .map((handle) => names.get(handle) ?? handle)
    .filter((name) => name && !name.startsWith('<@'));
}
