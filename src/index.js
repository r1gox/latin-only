/**
 * SoloLatino API independiente
 * Rutas:
 *   GET /?q=spider-man              → búsqueda
 *   GET /pelicula/{slug}            → detalle película + players
 *   GET /serie/{slug}               → detalle serie (info básica)
 *   GET /serie/{slug}/{temp}/{ep}   → capítulo + players
 *   GET /players?url=https://sololatino.net/...  → solo players
 */

const BASE = 'https://sololatino.net';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders(),
  });
}

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

/** Junta Set-Cookie en un solo Cookie header */
function mergeCookies(prev, res) {
  let jar = prev || '';
  const add = (raw) => {
    if (!raw) return;
    const pair = String(raw).split(';')[0].trim();
    if (!pair || !pair.includes('=')) return;
    const name = pair.split('=')[0];
    const re = new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^;]*', 'i');
    if (re.test(jar)) jar = jar.replace(re, pair);
    else jar = jar ? jar + '; ' + pair : pair;
  };
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      res.headers.getSetCookie().forEach(add);
    } else {
      const sc = res.headers.get('set-cookie');
      if (sc) {
        // varios set-cookie a veces concatenados
        sc.split(/,(?=[^;]+?=)/).forEach(add);
      }
    }
  } catch (_) {}
  return jar;
}

function getCookieValue(jar, name) {
  if (!jar) return null;
  const m = jar.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 1) Carga la página (tokens + cookies)
 * 2) sanctum/csrf-cookie
 * 3) POST /api/player-url { t: token } por cada servidor
 */
async function obtenerPlayersDesdeUrl(pageUrl) {
  // --- página ---
  let cookieJar = '';
  const pageRes = await fetch(pageUrl, {
    headers: htmlHeaders(),
    redirect: 'follow',
  });
  cookieJar = mergeCookies(cookieJar, pageRes);
  if (!pageRes.ok) {
    throw new Error('SoloLatino página HTTP ' + pageRes.status);
  }
  const html = await pageRes.text();

  // botones: data-player-token + texto del botón
  const servers = [];
  const reBtn =
    /<button([^>]*class="[^"]*server-btn[^"]*"[^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = reBtn.exec(html))) {
    const attrs = m[1];
    const tokenM = attrs.match(/data-player-token="([^"]+)"/i);
    if (!tokenM) continue;
    const nombre = String(m[2])
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Servidor';
    servers.push({ nombre, token: tokenM[1] });
  }

  // fallback: solo tokens
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
      nota: 'Sin data-player-token en la página',
    };
  }

  // --- sanctum ---
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
  if (!xsrf) {
    throw new Error('SoloLatino: no se obtuvo XSRF-TOKEN');
  }

  // --- resolver cada token ---
  const reproductores = [];
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
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
      if (data && data.url) {
        reproductores.push({
          servidor: s.nombre,
          url: data.url,
          tipo: data.type === 'iframe' ? 'embed' : data.type || 'embed',
          fuente: 'sololatino',
        });
      }
    } catch (_) {
      /* siguiente servidor */
    }
  }

  return {
    success: true,
    link: pageUrl,
    total: reproductores.length,
    reproductores,
  };
}

/** Búsqueda rápida (JSON) */
async function buscarSololatino(q) {
  q = String(q || '').trim();
  if (!q) return { query: q, count: 0, results: [] };

  // 1) API JSON (a veces 403 desde Workers)
  try {
    const apiUrl = BASE + '/api/search/suggest?q=' + encodeURIComponent(q);
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: BASE + '/',
        Origin: BASE,
      },
    });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        const results = [];
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (!it || it.type === 'person') continue;
          let tipo = 'Pelicula';
          if (it.type === 'series' || it.type === 'toon') tipo = 'Serie';
          results.push({
            title: it.title || null,
            year: it.year || null,
            type: tipo,
            portada: it.poster || null,
            url: it.url || null,
            source: 'sololatino',
          });
        }
        return { query: q, count: results.length, results };
      }
    }
  } catch (_) {
    /* fallback HTML */
  }

  // 2) Fallback: página /buscar?q=
  const htmlUrl = BASE + '/buscar?q=' + encodeURIComponent(q);
  const pageRes = await fetch(htmlUrl, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
      Referer: BASE + '/',
    },
  });
  if (!pageRes.ok) {
    throw new Error('Search HTTP ' + pageRes.status);
  }
  const html = await pageRes.text();

  const results = [];
  const seen = Object.create(null);

  // enlaces /pelicula/ o /serie/
  const re =
    /href="(https:\/\/sololatino\.net\/(pelicula|serie)\/([a-z0-9\-]+))"[\s\S]{0,400}?>([^<]{2,120})</gi;
  let m;
  while ((m = re.exec(html))) {
    const link = m[1];
    const kind = m[2].toLowerCase();
    const slug = m[3];
    if (seen[slug]) continue;
    seen[slug] = 1;
    const title = m[4].replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2) continue;
    results.push({
      title,
      slug,
      type: kind === 'serie' ? 'Serie' : 'Pelicula',
      url: link,
      source: 'sololatino',
    });
  }

  // si el regex de título falló, al menos por href
  if (!results.length) {
    const re2 =
      /href="(https:\/\/sololatino\.net\/(pelicula|serie)\/([a-z0-9\-]+))"/gi;
    while ((m = re2.exec(html))) {
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
  }

  // portadas cercanas (opcional)
  for (let i = 0; i < results.length; i++) {
    const slug = results[i].slug;
    if (!slug) continue;
    const reImg = new RegExp(
      slug + '[\\s\\S]{0,300}?(?:src|data-src)="(https://[^"]+(?:tmdb|poster|image)[^"]*)"',
      'i'
    );
    const im = html.match(reImg);
    if (im) results[i].portada = im[1];
  }

  return { query: q, count: results.length, results };
}

/** Meta mínima desde HTML */
function parseMetaBasica(html, pageUrl) {
  const titulo =
    (html.match(/property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/<title>([^<]+)/i) ||
      [])[1] || null;
  const desc =
    (html.match(/property="og:description"\s+content="([^"]+)"/i) || [])[1] ||
    null;
  const portada =
    (html.match(/property="og:image"\s+content="([^"]+)"/i) || [])[1] || null;
  let slug = null;
  const sm = String(pageUrl).match(
    /\/(?:pelicula|serie)\/([^\/\?#]+)/i
  );
  if (sm) slug = sm[1];
  return {
    titulo: titulo ? titulo.replace(/\s*[—|\-].*$/, '').trim() : null,
    descripcion: desc,
    portada,
    slug,
    link: pageUrl,
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);

    try {
      // GET /?q=texto
      const q = url.searchParams.get('q') || url.searchParams.get('query');
      if (q && parts.length === 0) {
        return json(await buscarSololatino(q));
      }

      // GET /players?url=...
      if (parts[0] === 'players') {
        const target = url.searchParams.get('url');
        if (!target) {
          return json({ error: 'Falta url. Uso: /players?url=https://sololatino.net/...' }, 400);
        }
        return json(await obtenerPlayersDesdeUrl(target));
      }

      // GET /pelicula/{slug}
      if (parts[0] === 'pelicula' && parts[1]) {
        const pageUrl = BASE + '/pelicula/' + parts[1];
        const pageRes = await fetch(pageUrl, { headers: htmlHeaders() });
        const html = await pageRes.text();
        const meta = parseMetaBasica(html, pageUrl);
        const players = await obtenerPlayersDesdeUrl(pageUrl);
        return json({
          success: true,
          fuente: 'sololatino',
          tipo: 'Pelicula',
          ...meta,
          total: players.total,
          reproductores: players.reproductores,
        });
      }

      // GET /serie/{slug}/{temp}/{ep}
      if (parts[0] === 'serie' && parts[1] && parts[2] && parts[3]) {
        const slug = parts[1];
        const temp = parseInt(parts[2], 10) || 1;
        const ep = parseInt(parts[3], 10) || 1;
        const pageUrl =
          BASE +
          '/serie/' +
          slug +
          '/temporada-' +
          temp +
          '/episodio-' +
          ep;
        const players = await obtenerPlayersDesdeUrl(pageUrl);
        return json({
          success: true,
          fuente: 'sololatino',
          tipo: 'Capitulo',
          slug,
          temporada: temp,
          episodio: ep,
          link: pageUrl,
          total: players.total,
          reproductores: players.reproductores,
        });
      }

      // GET /serie/{slug}
      if (parts[0] === 'serie' && parts[1]) {
        const pageUrl = BASE + '/serie/' + parts[1];
        const pageRes = await fetch(pageUrl, { headers: htmlHeaders() });
        const html = await pageRes.text();
        const meta = parseMetaBasica(html, pageUrl);
        return json({
          success: true,
          fuente: 'sololatino',
          tipo: 'Serie',
          ...meta,
          nota: 'Usa /serie/{slug}/{temp}/{ep} para players',
        });
      }

      return json({
        uso: {
          busqueda: '/?q=spider-man',
          pelicula: '/pelicula/spider-man-no-way-home',
          capitulo: '/serie/made-in-korea/2/1',
          players: '/players?url=https://sololatino.net/serie/made-in-korea/temporada-2/episodio-1',
        },
      });
    } catch (err) {
      return json(
        { success: false, error: err.message || String(err) },
        502
      );
    }
  },
};
