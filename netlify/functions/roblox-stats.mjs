// Live names, icons, thumbnails, visits and favorites for the games on the site.
// Roblox's API doesn't allow browsers on other sites to read it, so the page asks this function instead.
// Netlify's CDN keeps the answer for 10 minutes, so Roblox is called at most a few times an hour.

// universe IDs (not place IDs) of the 8 games, looked up from apis.roblox.com/universes/v1/places/<placeId>/universe
const UNIVERSES = [
  10479483082, // Bangali Era
  10080882090, // Ondhokar
  10764929985, // CTG CITY
  9195047050,  // Bangali Hood (place 134757873036097)
  9892395751,  // Bangla Town
  10771061328, // Lumina Hangout
  10770998037, // Bengali Society
  10294847053, // Mystic Hangout
];

export default async () => {
  try {
    const ids = UNIVERSES.join(',');
    const get = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error('roblox ' + r.status); return r.json(); });
    // images are optional: if a thumbnail call fails the page keeps its own pictures
    const images = (url) => get(url).then((d) => d.data).catch(() => []);
    const [{ data }, thumbs, icons] = await Promise.all([
      get('https://games.roblox.com/v1/games?universeIds=' + ids),
      images('https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=' + ids + '&countPerUniverse=1&size=768x432&format=Webp'),
      images('https://thumbnails.roblox.com/v1/games/icons?universeIds=' + ids + '&size=256x256&format=Webp'),
    ]);
    const thumbOf = {};
    for (const t of thumbs) {
      const first = (t.thumbnails || [])[0];
      if (first && first.state === 'Completed') thumbOf[t.universeId] = first.imageUrl;
    }
    const iconOf = {};
    for (const i of icons) if (i.state === 'Completed') iconOf[i.targetId] = i.imageUrl;

    const games = {};
    let totalVisits = 0;
    for (const g of data) {
      games[g.id] = { name: g.name, visits: g.visits, favorites: g.favoritedCount, thumbnail: thumbOf[g.id] || null, icon: iconOf[g.id] || null };
      totalVisits += g.visits;
    }

    return Response.json({ games, totalVisits, updated: new Date().toISOString() }, {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=600, stale-while-revalidate=86400',
      },
    });
  } catch (e) {
    // the page keeps its built-in numbers when this fails
    return Response.json({ error: 'unavailable' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
};

export const config = { path: '/api/roblox-stats' };
