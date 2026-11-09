// Fetches live names, icons, thumbnails, visits and favorites of the games on the site from Roblox.
// Run by .github/workflows/stats.yml every 15 minutes; the result is published to the repo's `data` branch,
// and the site reads it through worker/index.js (/api/roblox-stats).
// Roblox blocks Cloudflare's shared servers (429), which is why this runs on GitHub instead.
//
//   node scripts/refresh-stats.mjs <previous.json> <out.json>

import { readFile, writeFile } from 'node:fs/promises';

// universe IDs (not place IDs), looked up from apis.roblox.com/universes/v1/places/<placeId>/universe
const UNIVERSES = [
  10479483082, // Bangali Era
  10080882090, // Ondhokar
  10764929985, // CTG CITY
  9195047050,  // Bangali Hood (place 134757873036097)
  9892395751,  // Bangla Town
  10771061328, // Lumina Hangout
  10770998037, // Bengali Society
  10294847053, // Mystic Hangout
  10775372359, // Bangla Beach Hangout (place 116982119110039)
];

// Roblox's grey stand-in for games without pictures has GameMediaItem / GameIcon in its URL instead of Image
const isPlaceholder = (url) => /\/(GameMediaItem|GameIcon)\d*\//.test(url);

const [previousPath, outPath] = process.argv.slice(2);

async function get(url) {
  for (const wait of [0, 2000, 5000]) {
    if (wait) await new Promise((done) => setTimeout(done, wait));
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 3iaw.com stats)', Accept: 'application/json' } });
    if (r.ok) return r.json();
    if (r.status !== 429 && r.status < 500) throw new Error('roblox ' + r.status + ' ' + url);
  }
  throw new Error('roblox kept answering busy: ' + url);
}

const ids = UNIVERSES.join(',');
// images are optional: if a thumbnail call fails, the pictures from the last run are kept
const images = (url) => get(url).then((d) => d.data).catch((e) => { console.warn(e.message); return []; });
const [{ data }, thumbs, icons] = await Promise.all([
  get('https://games.roblox.com/v1/games?universeIds=' + ids),
  images('https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=' + ids + '&countPerUniverse=1&size=768x432&format=Webp'),
  images('https://thumbnails.roblox.com/v1/games/icons?universeIds=' + ids + '&size=256x256&format=Webp'),
]);

let previous = {};
try { previous = JSON.parse(await readFile(previousPath, 'utf8')).games || {}; } catch { /* first run */ }

const thumbOf = {};
for (const t of thumbs) {
  const first = (t.thumbnails || [])[0];
  if (first && first.state === 'Completed' && !isPlaceholder(first.imageUrl)) thumbOf[t.universeId] = first.imageUrl;
}
const iconOf = {};
for (const i of icons) if (i.state === 'Completed' && !isPlaceholder(i.imageUrl)) iconOf[i.targetId] = i.imageUrl;

const games = {};
let totalVisits = 0;
for (const g of data) {
  const old = previous[g.id] || {};
  // a placeholder saved by an older run isn't worth keeping
  if (old.thumbnail && isPlaceholder(old.thumbnail)) old.thumbnail = null;
  if (old.icon && isPlaceholder(old.icon)) old.icon = null;
  games[g.id] = {
    name: g.name, visits: g.visits, favorites: g.favoritedCount,
    thumbnail: thumbOf[g.id] || old.thumbnail || null,
    icon: iconOf[g.id] || old.icon || null,
  };
  totalVisits += g.visits;
}

await writeFile(outPath, JSON.stringify({ games, totalVisits, updated: new Date().toISOString() }, null, 1));
console.log('total visits', totalVisits, 'for', data.length, 'games');
