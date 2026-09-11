import express from 'express';
// pegar: buscarSololatino, obtenerPlayersDesdeUrl, helpers de cookies

const app = express();

app.get('/', async (req, res) => {
  try {
    if (!req.query.q) {
      return res.json({ uso: { busqueda: '/?q=spider', players: '/players?url=...' } });
    }
    res.json(await buscarSololatino(req.query.q));
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get('/players', async (req, res) => {
  try {
    res.json(await obtenerPlayersDesdeUrl(req.query.url));
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get('/serie/:slug/:temp/:ep', async (req, res) => {
  const { slug, temp, ep } = req.params;
  const pageUrl = `https://sololatino.net/serie/${slug}/temporada-${temp}/episodio-${ep}`;
  try {
    res.json({
      success: true,
      tipo: 'Capitulo',
      slug,
      temporada: Number(temp),
      episodio: Number(ep),
      ...(await obtenerPlayersDesdeUrl(pageUrl)),
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('on', port));
