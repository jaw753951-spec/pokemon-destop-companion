/**
 * Every Pokémon's cry.
 *
 * The step once packed each Pokémon's battle sprites and box icon as well;
 * those are now the `art` step's, from one folder of Black and White style
 * sprites, and this is what is left.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { CRIES, MAX_SPECIES } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildSprites({ assetDir, dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;
  // The regional Pokémon the dex step files under their variety ids, whose
  // cries PokeAPI files under the same ids.
  const species = JSON.parse(await readFile(join(dataDir, 'species.json'), 'utf8'));
  const regional = Object.values(species)
    .filter((entry) => entry.regional && entry.dex <= limit)
    .map((entry) => entry.id);
  const ids = [...Array.from({ length: limit }, (_, index) => index + 1), ...regional];
  const missing = [];
  let found = 0;
  await Promise.all(
    ids.map((id) =>
      pool(async () => {
        const cry = await fetchBuffer(`${CRIES}/pokemon/latest/${id}.ogg`, { allowMissing: true });
        if (!cry) {
          missing.push(id);
          return;
        }
        await writeOut(join(assetDir, 'cries', `${id}.ogg`), cry);
        found++;
      }),
    ),
  );
  log(`cries ${found}/${ids.length}`);
  if (missing.length) log(`  missing: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}`);
}
