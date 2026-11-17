// Downloads the Semaphore v4 circuit artifacts (wasm + zkey, one pair per Merkle tree depth) into
// public/semaphore/ so the browser proves against LOCAL files (served by Vite) instead of fetching
// them from the PSE CDN at proving time.
//
//   npm run artifacts                      depths 1..10  (groups up to 1024 members, ~45 MB)
//   node scripts/fetch-semaphore-artifacts.mjs --max-depth 16
//   ... --soft                             never fail (used by predev/prebuild: warn and continue)
//
// A group with n members needs depth ceil(log2(n)) (minimum 1). Existing files are kept.
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SEMAPHORE_ARTIFACTS_SOURCE ?? 'https://snark-artifacts.pse.dev/semaphore/4.0.0';
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/semaphore');
const soft = process.argv.includes('--soft');
const maxIdx = process.argv.indexOf('--max-depth');
const maxDepth = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : 10;
if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) {
  console.error('--max-depth must be an integer in 1..32');
  process.exit(1);
}

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

async function fetchTo(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const tmp = `${file}.part`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, file); // never leave a truncated artifact under the final name
}

try {
  await mkdir(out, { recursive: true });
  let downloaded = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    for (const ext of ['wasm', 'zkey']) {
      const file = resolve(out, `semaphore-${depth}.${ext}`);
      if (await exists(file)) continue;
      await fetchTo(`${BASE}/semaphore-${depth}.${ext}`, file);
      downloaded++;
    }
  }
  console.log(`[artifacts] depths 1..${maxDepth} ready in public/semaphore (${downloaded} file(s) downloaded)`);
} catch (err) {
  console.error(`[artifacts] ${soft ? 'warning' : 'error'}: ${err.message}`);
  if (soft) console.error('[artifacts] run `npm run artifacts` later, or set VITE_SEMAPHORE_ARTIFACTS_URL=cdn to use the PSE CDN.');
  process.exit(soft ? 0 : 1);
}
