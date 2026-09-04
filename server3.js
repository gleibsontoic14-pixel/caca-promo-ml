const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || '000';
const SCAN_MINUTES = Math.max(5, Number(process.env.SCAN_MINUTES || 15));
const ML_CLIENT_ID = process.env.ML_CLIENT_ID || '';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || '';
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://caca-promo-ml.onrender.com/oauth/callback';
const ML_ACCESS_TOKEN_ENV = process.env.ML_ACCESS_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaults = {
  settings: { minDiscount: 0, maxPrice: 0, freeOnly: false, minScore: 0, scanMinutes: SCAN_MINUTES, autoScan: true },
  watchlists: [{ id: 'inicial', query: 'ofertas', enabled: true }],
  queue: [],
  seen: {},
  oauth: { access_token: '', refresh_token: '', expires_at: 0, user_id: null },
  oauth_state: null,
  lastScanAt: null,
  lastScanMessage: 'Ainda não executado.'
};

function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      ...structuredClone(defaults),
      ...d,
      settings: { ...defaults.settings, ...(d.settings || {}) },
      oauth: { ...defaults.oauth, ...(d.oauth || {}) }
    };
  } catch {
    return structuredClone(defaults);
  }
}

let state = loadState();
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key'
  });
  res.end(JSON.stringify(data));
}
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function isAdmin(req, res) {
  if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY) {
    json(res, 401, { error: 'Senha ADMIN inválida.' });
    return false;
  }
  return true;
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
function serveStatic(url, res) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    send(res, 200, data, types[ext] || 'application/octet-stream');
  });
}

function oauthReady() { return Boolean(ML_CLIENT_ID && ML_CLIENT_SECRET && ML_REDIRECT_URI); }
function connected() { return Boolean(ML_ACCESS_TOKEN_ENV || state.oauth?.access_token); }
async function tokenRequest(params) {
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || d.error_description || d.error || `OAuth ${r.status}`);
  return d;
}
function storeToken(d) {
  state.oauth = {
    access_token: d.access_token || '',
    refresh_token: d.refresh_token || state.oauth?.refresh_token || '',
    expires_at: Date.now() + Math.max(0, Number(d.expires_in || 21600) - 120) * 1000,
    user_id: d.user_id || state.oauth?.user_id || null
  };
  save();
}
async function ensureToken() {
  if (ML_ACCESS_TOKEN_ENV) return ML_ACCESS_TOKEN_ENV;
  if (state.oauth?.access_token && Number(state.oauth.expires_at || 0) > Date.now()) return state.oauth.access_token;
  if (state.oauth?.refresh_token && oauthReady()) {
    const d = await tokenRequest({
      grant_type: 'refresh_token', client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET, refresh_token: state.oauth.refresh_token
    });
    storeToken(d);
    return state.oauth.access_token;
  }
  throw new Error('Mercado Livre não conectado.');
}
async function mlGet(url) {
  const token = await ensureToken();
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'CacaPromoML/3.0' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`API ${r.status}: ${text.slice(0, 180)}`);
  return JSON.parse(text);
}

function moneyFromNode(node) {
  if (!node || !node.length) return 0;
  const fraction = node.find('.andes-money-amount__fraction').first().text().replace(/\D/g, '');
  const cents = node.find('.andes-money-amount__cents').first().text().replace(/\D/g, '');
  if (fraction) return Number(fraction) + (cents ? Number(cents) / 100 : 0);
  const raw = node.attr('aria-label') || node.text() || '';
  const m = raw.replace(/R\$/gi, '').replace(/\s/g, '').match(/([0-9.]+(?:,[0-9]{1,2})?)/);
  if (!m) return 0;
  return Number(m[1].replace(/\./g, '').replace(',', '.')) || 0;
}
function normalizeLink(href) {
  if (!href) return '';
  try {
    const u = new URL(href, 'https://lista.mercadolivre.com.br');
    ['tracking_id','matt_tool','matt_word','matt_source','matt_campaign','matt_ad_group','matt_match_type','matt_network','matt_device'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch { return href; }
}
function itemIdFromLink(link, idx) {
  const m = String(link).match(/MLB-?(\d{6,})/i) || String(link).match(/MLB(\d{6,})/i);
  return m ? `MLB${m[1]}` : `WEB-${crypto.createHash('sha1').update(link + idx).digest('hex').slice(0, 12)}`;
}
function scoreOf(discount, free, official = false) { return Math.round(Math.min(100, discount * 1.7 + (free ? 8 : 0) + (official ? 5 : 0))); }
function searchUrl(query) { return `https://lista.mercadolivre.com.br/${encodeURIComponent(String(query || '').trim()).replace(/%20/g, '-')}`; }

async function publicSearch(query) {
  const r = await fetch(searchUrl(query), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error(`Página pública ${r.status}`);
  const html = await r.text();
  const $ = cheerio.load(html);
  const out = [];
  const cards = $('.ui-search-layout__item, li.ui-search-layout__item, .poly-card').toArray();

  cards.forEach((el, idx) => {
    const c = $(el);
    const a = c.find('a.poly-component__title, a.ui-search-link, a[href*="mercadolivre.com.br"]').first();
    if (!a.length) return;
    const link = normalizeLink(a.attr('href'));
    const title = (a.text() || c.find('.ui-search-item__title, .poly-component__title').first().text() || '').trim();
    if (!link || !title) return;

    const currentNode = c.find('.poly-price__current .andes-money-amount, .ui-search-price__second-line .andes-money-amount, .andes-money-amount').first();
    const previousNode = c.find('.andes-money-amount--previous, .poly-price__previous .andes-money-amount, s .andes-money-amount').first();
    const price = moneyFromNode(currentNode);
    const original = moneyFromNode(previousNode);
    if (!price) return;

    const text = c.text();
    const off = text.match(/(\d{1,2})%\s*OFF/i);
    const discountKnown = Boolean(off || (original > price));
    const discount = off ? Number(off[1]) : (original > price ? Math.round((1 - price / original) * 100) : 0);
    const free = /frete\s*gr[aá]tis/i.test(text);
    const official = /loja oficial/i.test(text);
    const img = c.find('img').first();
    const thumb = img.attr('data-src') || img.attr('src') || '';

    out.push({
      id: itemIdFromLink(link, idx), query, title, price,
      original_price: original > price ? original : null,
      discount, discount_known: discountKnown,
      permalink: link, thumbnail: thumb, free_shipping: free,
      sold_quantity: 0, official_store: official,
      score: scoreOf(discount, free, official), affiliate_url: '', status: 'pending',
      found_at: new Date().toISOString(), source: 'pagina_publica'
    });
  });

  if (!out.length) {
    const scripts = $('script[type="application/ld+json"]').toArray();
    for (const s of scripts) {
      try {
        const parsed = JSON.parse($(s).html());
        const roots = Array.isArray(parsed) ? parsed : [parsed];
        for (const root of roots) {
          const entries = root?.itemListElement || [];
          for (const [idx, entry] of entries.entries()) {
            const p = entry.item || entry;
            const offer = Array.isArray(p.offers) ? p.offers[0] : (p.offers || {});
            const price = Number(offer.price || 0);
            const link = normalizeLink(p.url || entry.url || '');
            if (!price || !link) continue;
            out.push({
              id: itemIdFromLink(link, idx), query, title: p.name || 'Produto Mercado Livre', price,
              original_price: null, discount: 0, discount_known: false, permalink: link,
              thumbnail: Array.isArray(p.image) ? p.image[0] : (p.image || ''), free_shipping: false,
              sold_quantity: 0, official_store: false, score: 0, affiliate_url: '', status: 'pending',
              found_at: new Date().toISOString(), source: 'json_ld'
            });
          }
        }
      } catch {}
    }
  }

  return [...new Map(out.map(x => [x.permalink, x])).values()].slice(0, 50);
}

async function catalogFallback(query) {
  if (!connected()) return [];
  try {
    const u = new URL('https://api.mercadolibre.com/products/search');
    u.searchParams.set('status', 'active');
    u.searchParams.set('site_id', 'MLB');
    u.searchParams.set('q', query);
    u.searchParams.set('limit', '20');
    const d = await mlGet(u);
    const out = [];
    for (const x of d.results || []) {
      const w = x.buy_box_winner;
      if (!w?.item_id || !Number(w.price)) continue;
      const price = Number(w.price);
      const original = Number(w.original_price || 0);
      const known = original > price;
      const discount = known ? Math.round((1 - price / original) * 100) : 0;
      out.push({
        id: w.item_id, query, title: x.name || x.family_name || w.item_id, price,
        original_price: known ? original : null, discount, discount_known: known,
        permalink: x.permalink || `https://www.mercadolivre.com.br/p/${x.id}`,
        thumbnail: x.pictures?.[0]?.url || '', free_shipping: Boolean(w.shipping?.free_shipping),
        sold_quantity: 0, official_store: Boolean(w.official_store_id),
        score: scoreOf(discount, Boolean(w.shipping?.free_shipping), Boolean(w.official_store_id)),
        affiliate_url: '', status: 'pending', found_at: new Date().toISOString(), source: 'api_catalogo'
      });
    }
    return out;
  } catch (e) {
    console.log('[CATALOGO]', e.message);
    return [];
  }
}

function passesFilters(p) {
  const s = state.settings;
  const min = Number(s.minDiscount || 0);
  return (min <= 0 || (p.discount_known && p.discount >= min))
    && (!Number(s.maxPrice || 0) || p.price <= Number(s.maxPrice))
    && (!s.freeOnly || p.free_shipping)
    && p.score >= Number(s.minScore || 0);
}

async function scan() {
  let added = 0, checked = 0, withDiscount = 0, passed = 0, publicCount = 0, apiCount = 0;
  const errors = [];
  for (const w of state.watchlists.filter(x => x.enabled)) {
    try {
      let products = [];
      try {
        products = await publicSearch(w.query);
        publicCount += products.length;
      } catch (e) {
        errors.push(`${w.query} página: ${e.message}`);
      }
      if (!products.length) {
        const fallback = await catalogFallback(w.query);
        products = fallback;
        apiCount += fallback.length;
      }
      checked += products.length;
      withDiscount += products.filter(p => p.discount_known && p.discount > 0).length;
      for (const p of products) {
        if (!passesFilters(p)) continue;
        passed++;
        if (state.seen[p.id]) continue;
        state.seen[p.id] = new Date().toISOString();
        state.queue.unshift(p);
        added++;
      }
    } catch (e) {
      errors.push(`${w.query}: ${e.message}`);
    }
  }
  state.queue = state.queue.slice(0, 500);
  state.lastScanAt = new Date().toISOString();
  const source = publicCount ? 'página pública' : (apiCount ? 'API' : 'nenhuma');
  state.lastScanMessage = `${added} novas promoções; ${checked} produtos encontrados; ${withDiscount} com desconto; ${passed} passaram os filtros (mín. ${Number(state.settings.minDiscount || 0)}%). Fonte: ${source}${errors.length ? `. Avisos: ${errors.join(' | ')}` : ''}`;
  save();
  console.log('[SCAN]', state.lastScanMessage);
  return { added, checked, withDiscount, passed, publicCount, apiCount, errors, at: state.lastScanAt };
}

function publicState() {
  return {
    settings: state.settings, watchlists: state.watchlists, queue: state.queue,
    lastScanAt: state.lastScanAt, lastScanMessage: state.lastScanMessage,
    tokenConfigured: connected(), oauthReady: oauthReady(), oauthUserId: state.oauth?.user_id || null,
    oauthExpiresAt: state.oauth?.expires_at || 0, redirectUri: ML_REDIRECT_URI,
    searchMode: 'hybrid_public_v2'
  };
}

let timer;
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (state.settings.autoScan) scan().catch(e => console.log('[AUTO]', e.message));
  }, Math.max(5, Number(state.settings.scanMinutes || 15)) * 60000);
}
schedule();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, tokenConfigured: connected(), oauthReady: oauthReady(), scanMinutes: state.settings.scanMinutes, searchMode: 'hybrid_public_v2' });

    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      let html = '';
      try {
        if (error) throw new Error(error);
        if (!code) throw new Error('Código de autorização não recebido.');
        if (!state.oauth_state || returnedState !== state.oauth_state.value || Date.now() > state.oauth_state.expires_at) throw new Error('State OAuth inválido ou expirado.');
        const d = await tokenRequest({ grant_type: 'authorization_code', client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET, code, redirect_uri: ML_REDIRECT_URI });
        storeToken(d);
        state.oauth_state = null;
        save();
        html = '<p style="color:#8df0aa;font-size:20px">✅ Mercado Livre conectado com sucesso!</p>';
      } catch (e) {
        html = `<p style="color:#ff8b8b">❌ ${String(e.message).replace(/[<>]/g, '')}</p>`;
      }
      return send(res, 200, `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d11;color:#fff;padding:40px"><h1>🔥 Caça Promo ML</h1>${html}<p><a style="color:#ffe000" href="/">Voltar ao painel</a></p></body>`, 'text/html; charset=utf-8');
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req, res)) return;
      if (url.pathname === '/api/admin/state' && req.method === 'GET') return json(res, 200, publicState());
      if (url.pathname === '/api/admin/oauth/start' && req.method === 'POST') {
        if (!oauthReady()) return json(res, 400, { error: 'Faltam credenciais do Mercado Livre no Render.' });
        const value = crypto.randomBytes(24).toString('hex');
        state.oauth_state = { value, expires_at: Date.now() + 10 * 60 * 1000 };
        save();
        const u = new URL('https://auth.mercadolivre.com.br/authorization');
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', ML_CLIENT_ID);
        u.searchParams.set('redirect_uri', ML_REDIRECT_URI);
        u.searchParams.set('state', value);
        return json(res, 200, { authUrl: u.toString() });
      }
      if (url.pathname === '/api/admin/oauth/disconnect' && req.method === 'POST') {
        state.oauth = structuredClone(defaults.oauth);
        state.oauth_state = null;
        save();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/admin/scan' && req.method === 'POST') return json(res, 200, await scan());
      if (url.pathname === '/api/admin/settings' && req.method === 'POST') {
        state.settings = { ...state.settings, ...await readBody(req) };
        save(); schedule();
        return json(res, 200, state.settings);
      }
      if (url.pathname === '/api/admin/watchlists' && req.method === 'POST') {
        const b = await readBody(req);
        const q = String(b.query || '').trim();
        if (!q) return json(res, 400, { error: 'Busca vazia.' });
        if (!state.watchlists.some(w => w.query.toLowerCase() === q.toLowerCase())) state.watchlists.push({ id: String(Date.now()), query: q, enabled: true });
        save();
        return json(res, 200, state.watchlists);
      }
      let m = url.pathname.match(/^\/api\/admin\/watchlists\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        state.watchlists = state.watchlists.filter(w => w.id !== decodeURIComponent(m[1]));
        save();
        return json(res, 200, state.watchlists);
      }
      m = url.pathname.match(/^\/api\/admin\/queue\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        const id = decodeURIComponent(m[1]);
        const p = state.queue.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'Produto não encontrado.' });
        const b = await readBody(req);
        if ('affiliate_url' in b) p.affiliate_url = String(b.affiliate_url || '').trim();
        if ('status' in b) p.status = String(b.status || 'pending');
        save();
        return json(res, 200, p);
      }
      if (m && req.method === 'DELETE') {
        state.queue = state.queue.filter(x => x.id !== decodeURIComponent(m[1]));
        save();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Rota não encontrada.' });
    }

    return serveStatic(url, res);
  } catch (e) {
    console.log('[HTTP]', e.message);
    return json(res, 500, { error: 'Erro interno.', details: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Caça Promo ML 3.0: http://localhost:${PORT}`);
  console.log('Busca híbrida: página pública + API oficial');
  if (state.settings.autoScan) scan().catch(e => console.log('[START]', e.message));
});
