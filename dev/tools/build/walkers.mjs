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
import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { fetchBuffer, fetchJson, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { concatX, crop, opaqueBounds, paletteShift, recolour } from '../lib/image.mjs';
import { MAX_SPECIES, SPRITE_COLLAB } from '../sources.mjs';
import { buildFollowers, halve } from './followers.mjs';

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

/**
 * The collab's name for a regional variety's form, where it differs from the
 * region's own: the Paldean Tauros breeds and the white-striped Basculin.
 *
 * @type {Record<string, string>}
 */
const COLLAB_FORM_NAMES = {
  'tauros-paldea-combat-breed': 'Paldea',
  'tauros-paldea-blaze-breed': 'Paldea_Blaze',
  'tauros-paldea-aqua-breed': 'Paldea_Aqua',
  'basculin-white-striped': 'White',
  'basculin-blue-striped': 'Blue',
  'darmanitan-galar-standard': 'Galar',
  'urshifu-rapid-strike': 'Rapid_Strike',
  // The varieties that are Pokémon of their own though no region names them.
  'lycanroc-midnight': 'Midnight',
  'lycanroc-dusk': 'Dusk',
  'toxtricity-low-key': 'Lowkey',
  'ursaluna-bloodmoon': 'Bloodmoon',
  'wormadam-sandy': 'Sand',
  'wormadam-trash': 'Trash',
  'pumpkaboo-small': 'Small',
  'pumpkaboo-large': 'Large',
  'pumpkaboo-super': 'Super',
  'gourgeist-small': 'Small',
  'gourgeist-large': 'Large',
  'gourgeist-super': 'Super',
};

/**
 * Where the collab draws a variety the dex keeps as a Pokémon of its own:
 * a region's form under its subgroup, and a species' female — the female
 * Meowstic, Indeedee and Basculegion — under the gender level of its own
 * sheets, `0000/0000/0002`, with the shiny female at `0000/0001/0002`.
 * Nothing when the collab has not drawn it, rather than the species' own
 * sheets under the variety's name.
 *
 * @param {any} root the species' tracker record
 * @param {string} key the species' number, four digits
 * @param {any} entry the variety's dex entry
 * @returns {{record: any, path: string, shinyRecord: any, shinyPath: string}|null}
 */
function collabVariety(root, key, entry) {
  if (entry.gender === 'female') {
    const plain = root?.subgroups?.['0000'];
    return {
      record: plain?.subgroups?.['0000']?.subgroups?.['0002'],
      path: `${key}/0000/0000/0002`,
      shinyRecord: plain?.subgroups?.['0001']?.subgroups?.['0002'],
      shinyPath: `${key}/0000/0001/0002`,
    };
  }
  const form = collabForm(root, entry.slug);
  if (!form) return null;
  const record = root?.subgroups?.[form];
  return { record, path: `${key}/${form}`, shinyRecord: record?.subgroups?.['0001'], shinyPath: `${key}/${form}/0001` };
}

/**
 * Which of a species' collab subgroups draws a regional variety.
 *
 * @param {any} record the species' tracker record
 * @param {string} slug the variety's slug
 * @returns {string|null} the subgroup's key
 */
function collabForm(record, slug) {
  const wanted =
    COLLAB_FORM_NAMES[slug] ??
    ['alola', 'galar', 'hisui', 'paldea'].find((region) => slug.includes(`-${region}`))?.replace(/^./, (c) => c.toUpperCase());
  if (!wanted) return null;
  const found = Object.entries(record?.subgroups ?? {}).find(([, group]) => group.name === wanted);
  return found?.[0] ?? null;
}

/**
 * The collab's name for an alternate forme, where it is not the forme slug's
 * tail title-cased (`rotom-heat` → `Heat`, `darmanitan-galar-zen` →
 * `Galar_Zen`).
 *
 * The masked Ogerpon are the canon sets the collab names by the mask alone;
 * its `_Mask` sets are the Terastal ones, crystal all over.
 *
 * @type {Record<string, string>}
 */
const COLLAB_FORME_NAMES = {
  'oricorio-pau': 'Pa_U',
  'zacian-crowned': 'Crowned_Sword',
  'zamazenta-crowned': 'Crowned_Shield',
  'necrozma-dusk': 'Dusk_Mane',
  'necrozma-dawn': 'Dawn_Wings',
  'calyrex-ice': 'Ice_Rider',
  'calyrex-shadow': 'Shadow_Rider',
  'ogerpon-wellspring-mask': 'Wellspring',
  'ogerpon-hearthflame-mask': 'Hearthflame',
  'ogerpon-cornerstone-mask': 'Cornerstone',
};

/**
 * Which of a species' collab subgroups draws one of its alternate formes.
 *
 * @param {any} record the species' tracker record
 * @param {string} speciesSlug the slug of the species the dex number is
 * @param {string} formeSlug
 * @returns {string|null} the subgroup's key
 */
export function collabForme(record, speciesSlug, formeSlug) {
  const wanted =
    COLLAB_FORME_NAMES[formeSlug] ??
    formeSlug
      .replace(new RegExp(`^${speciesSlug}-`), '')
      .split('-')
      .map((part) => part.replace(/^./, (c) => c.toUpperCase()))
      .join('_');
  const found = Object.entries(record?.subgroups ?? {}).find(([, group]) => group.name === wanted);
  return found?.[0] ?? null;
}

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
  /** The formes the collab has not drawn, which walk in the species' own art. @type {string[]} */
  const missingFormes = [];

  // The regional Pokémon the dex step files under their variety ids walk in
  // the collab's form sheets, under the species' own number.
  /** @type {Record<string, any>} */
  const species = JSON.parse(await readFile(join(dataDir, 'species.json'), 'utf8'));
  const regional = Object.values(species).filter((entry) => entry.regional && entry.dex <= limit);
  const ids = [...Array.from({ length: limit }, (_, index) => index + 1), ...regional.map((entry) => entry.id)];

  await Promise.all(
    ids.map((id) =>
      pool(async () => {
        const entry = manifest[id] ?? (manifest[id] = { shiny: {} });
        entry.shiny ??= {};
        for (const into of [entry, entry.shiny]) {
          for (const name of Object.keys(into)) {
            if (POSES.some((pose) => name === pose.key || name.startsWith(`${pose.key}-`))) delete into[name];
          }
        }

        const dex = species[id]?.dex ?? id;
        const key = String(dex).padStart(4, '0');
        // A species' shiny sits under its normal subgroup; a form's directly
        // under the form.
        const variety = species[id]?.regional
          ? collabVariety(tracker?.[key], key, species[id])
          : {
              record: tracker?.[key],
              path: key,
              shinyRecord: tracker?.[key]?.subgroups?.['0000']?.subgroups?.['0001'],
              shinyPath: `${key}/0000/0001`,
            };
        const { record, path, shinyRecord, shinyPath } = variety ?? { record: null, path: key, shinyRecord: null, shinyPath: '' };
        // The tracker lists a sheet by name whether or not it is locked, and
        // the value is only the lock: `Walk: false` is a walk that exists.
        // A variety's sheet that is byte for byte its species' — the collab's
        // Rapid Strike Urshifu is the Single Strike one — draws nothing of its
        // own, and is looked for elsewhere like one never drawn.
        if (!hasSheet(record, 'Walk') || (species[id]?.regional && (await sameSheet(path, key)))) {
          missing.push(id);
          return;
        }

        const variants = [
          { suffix: '', into: entry, base: `${SPRITE_COLLAB}/sprite/${path}`, record },
          ...(hasSheet(shinyRecord, 'Walk')
            ? [{ suffix: '-shiny', into: entry.shiny, base: `${SPRITE_COLLAB}/sprite/${shinyPath}`, record: shinyRecord }]
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
          // `iconFrom` marks an icon this step made, which a later run makes
          // again rather than mistaking it for one the icon sets published.
          if (dex > LAST_BOX_ICON || (species[id]?.regional && (!entry.icon || entry.iconFrom === 'walker'))) {
            const icon = await buildIcon(variant.base, anims);
            if (icon) {
              await writeOut(join(assetDir, 'pokemon', String(id), `icon${variant.suffix}.png`), icon.png);
              variant.into.icon = icon.meta;
              entry.iconFrom = 'walker';
              iconed.add(variant.suffix);
              built = true;
            }
          }
          if (built) for (const name of creditsOf(variant.record, names)) artists.add(name);
        }
        // A shiny icon left over from the render would be the one picture in
        // the box at another density; the ordinary colours in the right art
        // are the better miss.
        if (iconed.has('') && !iconed.has('-shiny')) {
          delete entry.shiny.icon;
          await rm(join(assetDir, 'pokemon', String(id), 'icon-shiny.png'), { force: true });
        }
        if (!entry.walk) missing.push(id);

        // A species whose female looks different walks as one: a Jellicent
        // pink, a Pyroar without the mane. The collab keeps her under the
        // gender level of the species' sheets.
        if (!species[id]?.regional) {
          const plain = tracker?.[key]?.subgroups?.['0000'];
          const female = plain?.subgroups?.['0000']?.subgroups?.['0002'];
          const femaleShiny = plain?.subgroups?.['0001']?.subgroups?.['0002'];
          if (hasSheet(female, 'Walk')) {
            for (const variant of [
              { suffix: '', into: entry, base: `${SPRITE_COLLAB}/sprite/${key}/0000/0000/0002`, record: female },
              ...(hasSheet(femaleShiny, 'Walk')
                ? [{ suffix: '-shiny', into: entry.shiny, base: `${SPRITE_COLLAB}/sprite/${key}/0000/0001/0002`, record: femaleShiny }]
                : []),
            ]) {
              const anims = parseAnimData((await fetchBuffer(`${variant.base}/AnimData.xml`, { allowMissing: true }))?.toString('utf8'));
              let built = false;
              for (const pose of POSES) {
                const strip = await buildStrip(variant.base, anims, pose.anim);
                if (!strip) continue;
                await writeOut(join(assetDir, 'pokemon', String(id), `${pose.key}-female${variant.suffix}.png`), strip.png);
                variant.into[`${pose.key}-female`] = strip.meta;
                built = true;
              }
              if (built) for (const name of creditsOf(variant.record, names)) artists.add(name);
            }
          }
        }

        // The formes a battle, a held item or a key item puts it in walk and
        // stand in sheets of their own, beside the species' — a Rotom in its
        // washer, an Arceus in its plate's colours, a Mimikyu with its
        // disguise busted. The collab files each under the species' number,
        // with its shiny directly beneath it as a regional form's is.
        const speciesSlug = species[dex]?.slug ?? '';
        for (const forme of species[id]?.forms ?? []) {
          const group = collabForme(tracker?.[key], speciesSlug, forme.slug);
          const formeRecord = group ? tracker?.[key]?.subgroups?.[group] : null;
          if (!hasSheet(formeRecord, 'Walk')) {
            missingFormes.push(forme.slug);
            continue;
          }
          const formeShiny = formeRecord.subgroups?.['0001'];
          for (const variant of [
            { suffix: '', into: entry, base: `${SPRITE_COLLAB}/sprite/${key}/${group}`, record: formeRecord },
            ...(hasSheet(formeShiny, 'Walk')
              ? [{ suffix: '-shiny', into: entry.shiny, base: `${SPRITE_COLLAB}/sprite/${key}/${group}/0001`, record: formeShiny }]
              : []),
          ]) {
            const anims = parseAnimData((await fetchBuffer(`${variant.base}/AnimData.xml`, { allowMissing: true }))?.toString('utf8'));
            let built = false;
            for (const pose of POSES) {
              const strip = await buildStrip(variant.base, anims, pose.anim);
              if (!strip) continue;
              await writeOut(join(assetDir, 'pokemon', String(id), `${pose.key}-form-${forme.slug}${variant.suffix}.png`), strip.png);
              variant.into[`${pose.key}-form-${forme.slug}`] = strip.meta;
              built = true;
            }
            if (built) for (const name of creditsOf(variant.record, names)) artists.add(name);
          }
          if (!entry[`walk-form-${forme.slug}`]) missingFormes.push(forme.slug);
        }
      }),
    ),
  );

  // What the collab has not drawn walks in the Essentials packs' followers.
  const followers = await buildFollowers({ assetDir, species, manifest, ids, lastBoxIcon: LAST_BOX_ICON, pool, log });

  // A variety neither set draws — a small or a large Gourgeist — walks in its
  // species' art rather than its box icon: the same Pokémon, a size off.
  const borrowed = [];
  for (const id of ids) {
    const entry = manifest[id];
    const dex = species[id]?.dex;
    if (!entry || entry.walk || !dex || !manifest[dex]?.walk) continue;
    for (const [into, from, suffix] of [[entry, manifest[dex], ''], [entry.shiny, manifest[dex].shiny ?? {}, '-shiny']]) {
      for (const pose of POSES) {
        if (!from[pose.key]) continue;
        const file = await readFile(join(assetDir, 'pokemon', String(dex), `${pose.key}${suffix}.png`));
        await writeOut(join(assetDir, 'pokemon', String(id), `${pose.key}${suffix}.png`), file);
        into[pose.key] = from[pose.key];
      }
    }
    borrowed.push(species[id].slug);
  }
  if (borrowed.length) log(`walkers borrowed from their species: ${borrowed.join(', ')}`);

  // A forme only a battle puts a Pokémon in stands in its battle sprite, cut
  // down to the walking art's size.
  await shrinkBattleFormes({ assetDir, species, manifest, ids, log });

  // What someone drew by hand for this game goes over whatever the sets had.
  const authored = await applyAuthored({ assetDir, species, manifest, log });

  // And a shiny the sets never drew — or drew as a copy of the ordinary
  // sheet — is painted from the battle sprites' two palettes.
  await paintShinies({ assetDir, manifest, ids, log });

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
      ...(followers ? { followers } : {}),
    }),
  );

  const walking = Object.values(manifest).filter((entry) => entry.walk).length;
  const shiny = Object.values(manifest).filter((entry) => entry.shiny?.walk).length;
  const formes = Object.values(manifest).reduce(
    (total, entry) => total + Object.keys(entry).filter((name) => name.startsWith('walk-form-')).length,
    0,
  );
  log(`walkers ${walking}/${ids.length} (${shiny} with shiny art, ${formes} formes), ${artists.size} artists credited`);
  const stillFormes = missingFormes.filter((slug) =>
    Object.values(manifest).every((entry) => !entry[`walk-form-${slug}`] && !entry[`idle-form-${slug}`]),
  );
  if (stillFormes.length) {
    log(`  formes in their species' art: ${stillFormes.length} (${stillFormes.join(', ')})`);
  }
  const stillMissing = missing.filter((id) => !manifest[id]?.walk);
  if (stillMissing.length) {
    log(`  on their box icon: ${stillMissing.length} (${stillMissing.slice(0, 12).join(', ')}${stillMissing.length > 12 ? ', …' : ''})`);
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

  const source = await readSheet(base, `${file}-Anim.png`);
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

/**
 * Whether a variety's walking sheet is the very file its species walks in.
 *
 * @param {string} path the variety's sheet directory
 * @param {string} key the species' own
 */
async function sameSheet(path, key) {
  if (path === key) return true;
  const [mine, theirs] = await Promise.all([
    fetchBuffer(`${SPRITE_COLLAB}/sprite/${path}/Walk-Anim.png`, { allowMissing: true }),
    fetchBuffer(`${SPRITE_COLLAB}/sprite/${key}/Walk-Anim.png`, { allowMissing: true }),
  ]);
  if (!mine || !theirs) return false;
  const digest = (buffer) => createHash('sha1').update(buffer).digest('hex');
  return digest(mine) === digest(theirs);
}

/**
 * Standing art for the formes a battle alone puts a Pokémon in and no walking
 * set draws — a Cramorant with its catch, a Stellar Terapagos, a Galarian
 * Zen Mode — made from the forme's battle sprite.
 *
 * The battle sprites are drawn several times the walking art's size, so
 * the forme's is halved as many times as brings the species' own battle
 * sprite down to its own standing art: the forme keeps its size against
 * the species' shape, and every pixel stays a whole one. Each frame is turned
 * to face right, the way the walking art faces.
 *
 * @param {{assetDir: string, species: Record<string, any>, manifest: Record<string, any>, ids: number[], log: (message: string) => void}} context
 */
async function shrinkBattleFormes({ assetDir, species, manifest, ids, log }) {
  const made = [];
  for (const id of ids) {
    const entry = manifest[id];
    if (!entry?.front || !entry.idle) continue;
    for (const forme of species[id]?.forms ?? []) {
      if (entry[`walk-form-${forme.slug}`] || entry[`idle-form-${forme.slug}`] || !entry[`form-${forme.slug}`]) continue;
      const halvings = Math.max(0, Math.round(Math.log2(entry.front.height / entry.idle.height)));
      for (const [into, suffix] of [[entry, ''], [entry.shiny ?? {}, '-shiny']]) {
        const meta = into[`form-${forme.slug}`];
        if (!meta) continue;
        const sheet = decodePng(await readFile(join(assetDir, 'pokemon', String(id), `front-form-${forme.slug}${suffix}.png`)));
        const frames = Array.from({ length: meta.frames ?? 1 }, (_, index) => {
          let frame = crop(sheet, index * meta.width, 0, meta.width, meta.height);
          for (let step = 0; step < halvings; step++) frame = halve(frame);
          return mirror(frame);
        });
        const strip = concatX(frames);
        await writeOut(join(assetDir, 'pokemon', String(id), `idle-form-${forme.slug}${suffix}.png`), encodePng(strip.width, strip.height, strip.data));
        into[`idle-form-${forme.slug}`] = { ...meta, width: frames[0].width, height: frames[0].height };
      }
      made.push(forme.slug);
    }
  }
  if (made.length) log(`battle formes from their battle sprites: ${made.join(', ')}`);
}

/** @param {import('../lib/image.mjs').Raster} frame */
function mirror(frame) {
  const data = new Uint8Array(frame.data.length);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const from = (y * frame.width + (frame.width - 1 - x)) * 4;
      data.set(frame.data.subarray(from, from + 4), (y * frame.width + x) * 4);
    }
  }
  return { width: frame.width, height: frame.height, data };
}

/**
 * Shiny walking art for the Pokémon whose sheets have none of their own.
 *
 * The collab leaves some shinies undrawn and files others as a copy of the
 * ordinary sheet — a Pecharunt or an Ogerpon walks in its ordinary colours
 * either way. The box icons meet the same gap with a recolouring read off
 * the two battle sprites, colour for colour, and the walking art takes the
 * same one: the species' battle sprites for its own art and its female's,
 * a forme's for the forme's.
 *
 * @param {{assetDir: string, manifest: Record<string, any>, ids: number[], log: (message: string) => void}} context
 */
async function paintShinies({ assetDir, manifest, ids, log }) {
  const dir = (id) => join(assetDir, 'pokemon', String(id));
  const first = (sheet, meta) => crop(sheet, 0, 0, meta.width, meta.height);
  const digest = (buffer) => createHash('sha1').update(buffer).digest('hex');
  const painted = [];
  for (const id of ids) {
    const entry = manifest[id];
    if (!entry?.walk) continue;
    entry.shiny ??= {};
    /** The recolouring for a battle-sprite key, read once. @type {Map<string, Map<number, [number, number, number]>>} */
    const shifts = new Map();
    const shiftFor = async (front) => {
      if (shifts.has(front)) return shifts.get(front);
      let shift = new Map();
      const plain = entry[front];
      const shiny = entry.shiny[front];
      const file = front === 'front' ? 'front' : `front-${front}`;
      if (plain && shiny && plain.width === shiny.width && plain.height === shiny.height) {
        const [a, b] = await Promise.all([
          readFile(join(dir(id), `${file}.png`)),
          readFile(join(dir(id), `${file}-shiny.png`)),
        ]);
        shift = paletteShift(first(decodePng(a), plain), first(decodePng(b), shiny));
      }
      shifts.set(front, shift);
      return shift;
    };
    for (const key of Object.keys(entry)) {
      const pose = key === 'icon' || POSES.some((candidate) => key === candidate.key || key.startsWith(`${candidate.key}-`));
      if (!pose || !entry[key]?.width) continue;
      // Only an icon this step drew; the icon sets' own have theirs painted
      // by the sprites step.
      if (key === 'icon' && entry.iconFrom !== 'walker' && entry.iconFrom !== 'followers') continue;
      const plainFile = join(dir(id), `${key}.png`);
      const shinyFile = join(dir(id), `${key}-shiny.png`);
      const plain = await readFile(plainFile);
      if (entry.shiny[key]) {
        const shiny = await readFile(shinyFile).catch(() => null);
        if (shiny && digest(shiny) !== digest(plain)) continue;
      }
      const forme = key.match(/-form-(.+)$/)?.[1];
      const shift = await shiftFor(forme ? `form-${forme}` : 'front');
      if (shift.size === 0) continue;
      const recoloured = recolour(decodePng(plain), shift);
      await writeOut(shinyFile, encodePng(recoloured.width, recoloured.height, recoloured.data));
      entry.shiny[key] = entry[key];
      painted.push(`${id}:${key}`);
    }
  }
  if (painted.length) log(`shiny walking art painted from the battle sprites: ${painted.length}`);
}

/**
 * A file of a sheet set, from the collab or from a directory on disk.
 *
 * @param {string} base a URL or a local directory
 * @param {string} file
 * @returns {Promise<Buffer|null>}
 */
async function readSheet(base, file) {
  if (/^https?:/.test(base)) return fetchBuffer(`${base}/${file}`, { allowMissing: true });
  return readFile(join(base, file)).catch(() => null);
}

/** Where sprites drawn for this game are kept, one sheet set per directory. */
export const AUTHORED_SPRITES = fileURLToPath(new URL('../../../data/authored/sprites/', import.meta.url));

/**
 * Walking and standing art drawn by hand for this game, over whatever the
 * collab and the Essentials packs gave.
 *
 * Each directory under `data/authored/sprites/` is a sheet set in the
 * collab's own layout — `AnimData.xml`, `Walk-Anim.png`, `Idle-Anim.png`,
 * eight rows a direction, of which the one facing right (the third) is the
 * one this game draws — so a collab sheet can be copied in and drawn over.
 * The directory's name says what it draws, with `-shiny` on the end for the
 * shiny palette: a species or variety by its slug (`urshifu-rapid-strike`),
 * a forme by the forme's (`cramorant-gulping`), a species' female by its
 * slug and `-female` (`jellicent-female`).
 *
 * @param {{assetDir: string, species: Record<string, any>, manifest: Record<string, any>, log: (message: string) => void}} context
 * @returns {Promise<string[]>} the directories used
 */
async function applyAuthored({ assetDir, species, manifest, log }) {
  const names = await readdir(AUTHORED_SPRITES).catch(() => []);
  const used = [];
  const unknown = [];
  for (const name of names.sort()) {
    const target = authoredTarget(name, species);
    if (!target) {
      if (!name.startsWith('.') && !/\.(md|txt)$/i.test(name)) unknown.push(name);
      continue;
    }
    const base = join(AUTHORED_SPRITES, name);
    const anims = parseAnimData((await readSheet(base, 'AnimData.xml'))?.toString('utf8'));
    const entry = (manifest[target.id] ??= { shiny: {} });
    entry.shiny ??= {};
    const into = target.shiny ? entry.shiny : entry;
    let built = false;
    for (const pose of POSES) {
      const strip = await buildStrip(base, anims, pose.anim);
      if (!strip) continue;
      await writeOut(join(assetDir, 'pokemon', String(target.id), `${pose.key}${target.key}${target.shiny ? '-shiny' : ''}.png`), strip.png);
      into[`${pose.key}${target.key}`] = strip.meta;
      built = true;
    }
    if (built) used.push(name);
    else unknown.push(`${name} (no Walk or Idle in its AnimData.xml)`);
  }
  if (used.length) log(`drawn for this game: ${used.join(', ')}`);
  if (unknown.length) log(`  not used from data/authored/sprites: ${unknown.join(', ')}`);
  return used;
}

/**
 * What an authored sheet directory's name draws.
 *
 * @param {string} name
 * @param {Record<string, any>} species
 * @returns {{id: number, key: string, shiny: boolean}|null}
 */
export function authoredTarget(name, species) {
  const shiny = name.endsWith('-shiny');
  const slug = shiny ? name.slice(0, -'-shiny'.length) : name;
  const all = Object.values(species);
  const own = all.find((entry) => entry.slug === slug);
  if (own) return { id: own.id, key: '', shiny };
  const withForme = all.find((entry) => (entry.forms ?? []).some((form) => form.slug === slug));
  if (withForme) return { id: withForme.id, key: `-form-${slug}`, shiny };
  if (slug.endsWith('-female')) {
    const base = all.find((entry) => entry.slug === slug.slice(0, -'-female'.length) && !entry.regional);
    if (base) return { id: base.id, key: '-female', shiny };
  }
  return null;
}
