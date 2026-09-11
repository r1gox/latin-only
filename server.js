import express from 'express';

const BASE = 'https://sololatino.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function htmlHeaders(extra) {
  const h = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    Referer: BASE + '/',
  };
  if (extra) Object.assign(h, extra);
  return h;
}

function mergeCookies(prev, res) {
  let jar = prev || '';
  const add = (raw) => {
    if (!raw) return;
    const pair = String(raw).split(';')[0].trim();
    if (!pair || !pair.includes('=')) return;
    const name = pair.split('=')[0];
    const re = new RegExp(
      '(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^;]*',
      'i'
    );
    if (re.test(jar)) jar = jar.replace(re, pair);
    else jar = jar ? jar + '; ' + pair : pair;
  };
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      res.headers.getSetCookie().forEach(add);
    } else {
      const sc = res.headers.get('set-cookie');
      if (sc) sc.split(/,(?=[^;]+?=)/).forEach(add);
    }
  } catch (_) {}
  return jar;
}

function getCookieValue(jar, name) {
  if (!jar) return null;
  const m = jar.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function obtenerPlayersDesdeUrl(pageUrl) {
  let cookieJar = '';
  const pageRes = await fetch(pageUrl, {
    headers: htmlHeaders(),
    redirect: 'follow',
  });
  cookieJar = mergeCookies(cookieJar, pageRes);
  if (!pageRes.ok) throw new Error('SoloLatino página HTTP ' + pageRes.status);
  const html = await pageRes.text();

  const servers = [];
  const reBtn =
    /<button([^>]*class="[^"]*server-btn[^"]*"[^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = reBtn.exec(html))) {
    const tokenM = m[1].match(/data-player-token="([^"]+)"/i);
    if (!tokenM) continue;
    const nombre =
      String(m[2])
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'Servidor';
    servers.push({ nombre, token: tokenM[1] });
  }
  if (!servers.length) {
    const reTok = /data-player-token="([^"]+)"/gi;
    let i = 0;
    while ((m = reTok.exec(html))) {
      i++;
      servers.push({ nombre: 'Servidor ' + i, token: m[1] });
    }
  }
  if (!servers.length) {
    return {
      success: true,
      link: pageUrl,
      total: 0,
      reproductores: [],
      nota: 'Sin data-player-token',
    };
  }

  const sanctumRes = await fetch(BASE + '/sanctum/csrf-cookie', {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: pageUrl,
      Cookie: cookieJar,
    },
  });
  cookieJar = mergeCookies(cookieJar, sanctumRes);
  const xsrf = getCookieValue(cookieJar, 'XSRF-TOKEN');
  if (!xsrf) throw new Error('SoloLatino: no XSRF-TOKEN');

  const reproductores = [];
  for (const s of servers) {
    try {
      const pr = await fetch(BASE + '/api/player-url', {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': xsrf,
          Origin: BASE,
          Referer: pageUrl,
          Cookie: cookieJar,
        },
        body: JSON.stringify({ t: s.token }),
      });
      cookieJar = mergeCookies(cookieJar, pr);
      if (!pr.ok) continue;
      const data = await pr.json();
      if (data?.url) {
        reproductores.push({
          servidor: s.nombre,
          url: data.url,
          tipo: data.type === 'iframe' ? 'embed' : data.type || 'embed',
          fuente: 'sololatino',
        });
      }
    } catch (_) {}
  }

  return {
    success: true,
    link: pageUrl,
    total: reproductores.length,
    reproductores,
  };
}

async function buscarSololatino(q) {
  q = String(q || '').trim();
  if (!q) return { query: q, count: 0, results: [] };

  // API JSON
  try {
    const res = await fetch(
      BASE + '/api/search/suggest?q=' + encodeURIComponent(q),
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: BASE + '/',
          Origin: BASE,
        },
      }
    );
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        const results = arr
          .filter((it) => it && it.type !== 'person')
          .map((it) => ({
            title: it.title || null,
            year: it.year || null,
            type:
              it.type === 'series' || it.type === 'toon' ? 'Serie' : 'Pelicula',
            portada: it.poster || null,
            url: it.url || null,
            source: 'sololatino',
          }));
        return { query: q, count: results.length, results };
      }
    }
  } catch (_) {}

  // Fallback HTML
  const pageRes = await fetch(BASE + '/buscar?q=' + encodeURIComponent(q), {
    headers: htmlHeaders(),
  });
  if (!pageRes.ok) throw new Error('Search HTTP ' + pageRes.status);
  const html = await pageRes.text();
  const results = [];
  const seen = Object.create(null);
  const re =
    /href="(https:\/\/sololatino\.net\/(pelicula|serie)\/([a-z0-9\-]+))"/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[3];
    if (seen[slug]) continue;
    seen[slug] = 1;
    results.push({
      title: slug.replace(/-/g, ' '),
      slug,
      type: m[2].toLowerCase() === 'serie' ? 'Serie' : 'Pelicula',
      url: m[1],
      source: 'sololatino',
    });
  }
  return { query: q, count: results.length, results };
}

const app = express();

app.get('/', async (req, res) => {
  try {
    if (!req.query.q) {
      return res.json({
        uso: {
          busqueda: '/?q=spider-man',
          players: '/players?url=https://sololatino.net/...',
          capitulo: '/serie/made-in-korea/2/1',
          pelicula: '/pelicula/spider-man-no-way-home',
        },
      });
    }
    res.json(await buscarSololatino(req.query.q));
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get('/players', async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).json({ error: 'Falta url' });
    }
    res.json(await obtenerPlayersDesdeUrl(req.query.url));
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get('/pelicula/:slug', async (req, res) => {
  try {
    const pageUrl = BASE + '/pelicula/' + req.params.slug;
    const players = await obtenerPlayersDesdeUrl(pageUrl);
    res.json({
      success: true,
      fuente: 'sololatino',
      tipo: 'Pelicula',
      slug: req.params.slug,
      link: pageUrl,
      ...players,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get('/serie/:slug/:temp/:ep', async (req, res) => {
  const { slug, temp, ep } = req.params;
  const pageUrl = `${BASE}/serie/${slug}/temporada-${temp}/episodio-${ep}`;
  try {
    const players = await obtenerPlayersDesdeUrl(pageUrl);
    res.json({
      success: true,
      fuente: 'sololatino',
      tipo: 'Capitulo',
      slug,
      temporada: Number(temp),
      episodio: Number(ep),
      link: pageUrl,
      ...players,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('latin-only on', port));
