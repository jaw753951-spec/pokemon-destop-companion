#!/usr/bin/env node
/**
 * Asset and data pipeline entry point.
 *
 *   npm run assets                 build everything
 *   npm run assets -- --only areas run one step
 *   npm run assets -- --sample     small slice, for checking the pipeline works
 *
 * Nothing this produces is committed: `assets/` holds the binaries the game
 * loads and `data/generated/` the JSON it reads, and both are gitignored.
 */
import { argv, env, exit } from 'node:process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool } from './lib/http.mjs';
import { buildAreas } from './build/areas.mjs';
import { buildDex } from './build/dex.mjs';
import { buildSprites } from './build/sprites.mjs';
import { buildWalkers } from './build/walkers.mjs';
import { buildItems } from './build/items.mjs';
import { buildActors } from './build/actors.mjs';
import { buildAudio } from './build/audio.mjs';
import { buildBattle } from './build/battle.mjs';
import { verifyAssets } from './build/verify.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** @type {Record<string, (context: any) => Promise<unknown>>} */
const STEPS = {
  dex: buildDex,
  sprites: buildSprites,
  walkers: buildWalkers,
  items: buildItems,
  actors: buildActors,
  areas: buildAreas,
  battle: buildBattle,
  audio: buildAudio,
  verify: verifyAssets,
};

async function main() {
  const args = new Set(argv.slice(2));
  const only = readOption('--only');
  const sample = args.has('--sample');

  const steps = only ? only.split(',') : Object.keys(STEPS);
  for (const step of steps) {
    if (!STEPS[step]) {
      console.error(`Unknown step "${step}". Known steps: ${Object.keys(STEPS).join(', ')}`);
      exit(1);
    }
  }

  const context = {
    assetDir: join(ROOT, 'assets'),
    // The sprite sheets every source publishes, gathered and cleaned up before
    // each Pokémon is cut down to the one picture the game ships.
    sheetDir: join(ROOT, '.cache', 'sheets'),
    dataDir: join(ROOT, 'data', 'generated'),
    docsDir: join(ROOT, 'dev', 'docs'),
    sample,
    pool: createPool(Number(env.PDC_CONCURRENCY ?? 16)),
    log: (message) => console.log(`  ${message}`),
  };

  for (const step of steps) {
    const startedAt = Date.now();
    console.log(`\n== ${step}${sample ? ' (sample)' : ''}`);
    await STEPS[step](context);
    console.log(`== ${step} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
}

/** @param {string} flag */
function readOption(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

main().catch((error) => {
  console.error(error);
  exit(1);
});
