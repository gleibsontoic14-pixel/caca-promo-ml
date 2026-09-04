const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
      ...structuredClone(defaults), ...d,
      settings: { ...defaults.settings, ...(d.settings || {}) },
      oauth: { ...defaults.oauth, ...(d.oauth || {}) }
    };
  } catch { return structuredClone(defaults); }
}

let state = loadState();
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key'
  });
  res.end(body);
}
function json(res, status, data) { send(res, status, JSON.stringify(data), 'application/json; charset=utf-8'); }
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
function oauthReady() { return Boolean(ML_CLIENT_ID && ML_CLIENT_SECRET && ML_REDIRECT_URI); }
function connected() { return Boolean(ML_ACCESS_TOKEN_ENV || state.oauth?.access_token); }
async function tokenRequest(params) {
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
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
    const d = await tokenRequest({ grant_type: 'refresh_token', client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET, refresh_token: state.oauth.refresh_token });
    storeToken(d);
    return state.oauth.access_token;
  }
  throw new Error('Mercado Livre não conectado.');
}
async function mlGet(url, attempts = 3) {
  const token = await ensureToken();
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'CacaPromoML/4.0' } });
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : {};
      last = `API ${r.status}: ${text.slice(0, 180)}`;
      if ([429, 500, 502, 503, 504].includes(r.status) && i < attempts - 1) { await sleep(350 * (i + 1)); continue; }
      throw new Error(last);
    } catch (e) {
      last = e.message;
      if (i < attempts - 1) { await sleep(350 * (i + 1)); continue; }
    }
  }
  throw new Error(last || 'Falha na API do Mercado Livre.');
}

function scoreOf(discount, free, official = false, rank = 20) {
  const rankBonus = Math.max(0, 12 - Math.floor((rank - 1) / 2));
  return Math.round(Math.min(100, discount * 1.7 + (free ? 8 : 0) + (official ? 5 : 0) + rankBonus));
}
function productLink(itemId) {
  const digits = String(itemId || '').replace(/^MLB/i, '');
  return digits ? `https://produto.mercadolivre.com.br/MLB-${digits}-_JM` : '';
}
function usefulTokens(query) {
  const stop = new Set(['de','da','do','das','dos','e','para','com','em','um','uma','the','of','pop']);
  return String(query || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(x => x.length >= 3 && !stop.has(x));
}
function titleMatches(title, query) {
  const tokens = usefulTokens(query);
  if (!tokens.length) return true;
  const t = String(title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return tokens.some(x => t.includes(x));
}

async function discoverDomain(query) {
  const u = new URL('https://api.mercadolibre.com/sites/MLB/domain_discovery/search');
  u.searchParams.set('q', query);
  u.searchParams.set('limit', '3');
  const d = await mlGet(u);
  const best = Array.isArray(d) ? d[0] : null;
  if (!best?.category_id) throw new Error('Não consegui identificar a categoria da busca.');
  const brand = (best.attributes || []).find(a => a.id === 'BRAND' && a.value_id);
  return { categoryId: best.category_id, categoryName: best.category_name || '', domainId: best.domain_id || '', brandId: brand?.value_id || '', brandName: brand?.value_name || '' };
}

async function highlights(categoryId, brandId = '') {
  const u = new URL(`https://api.mercadolibre.com/highlights/MLB/category/${encodeURIComponent(categoryId)}`);
  if (brandId) {
    u.searchParams.set('attribute', 'BRAND');
    u.searchParams.set('attributeValue', brandId);
  }
  return mlGet(u);
}

async function productDetail(productId) {
  return mlGet(`https://api.mercadolibre.com/products/${encodeURIComponent(productId)}`);
}
async function salePrice(itemId) {
  try {
    const u = new URL(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/sale_price`);
    u.searchParams.set('context', 'channel_marketplace');
    return await mlGet(u, 2);
  } catch { return null; }
}
async function itemBulk(ids) {
  if (!ids.length) return new Map();
  try {
    const u = new URL('https://api.mercadolibre.com/items/bulk');
    u.searchParams.set('ids', ids.slice(0, 20).join(','));
    u.searchParams.set('attributes', 'body.id,body.title,body.permalink,body.thumbnail,body.shipping,body.official_store_id');
    const d = await mlGet(u, 2);
    const map = new Map();
    for (const row of Array.isArray(d) ? d : []) {
      if (Number(row.status_code || row.code) === 200 && row.body?.id) map.set(row.body.id, row.body);
    }
    return map;
  } catch { return new Map(); }
}

function fromWinner(prod, winner, query, rank, sale) {
  const saleAmount = Number(sale?.amount || 0);
  const price = saleAmount > 0 ? saleAmount : Number(winner.price || 0);
  const regular = Number(sale?.regular_amount || winner.original_price || 0);
  if (!price) return null;
  const known = regular > price;
  const discount = known ? Math.round((1 - price / regular) * 100) : 0;
  const free = Boolean(winner.shipping?.free_shipping);
  const official = Boolean(winner.official_store_id);
  return {
    id: winner.item_id, query, title: prod.name || prod.family_name || winner.item_id,
    price, original_price: known ? regular : null, discount, discount_known: known,
    permalink: prod.permalink || productLink(winner.item_id),
    thumbnail: String(prod.pictures?.[0]?.url || prod.pictures?.[0]?.secure_url || '').replace(/^http:/, 'https:'),
    free_shipping: free, sold_quantity: Number(winner.sold_quantity || 0), official_store: official,
    score: scoreOf(discount, free, official, rank), affiliate_url: '', status: 'pending',
    found_at: new Date().toISOString(), source: 'mais_vendidos_produto', rank
  };
}
function fromItem(itemId, body, query, rank, sale) {
  const price = Number(sale?.amount || 0);
  if (!price) return null;
  const regular = Number(sale?.regular_amount || 0);
  const known = regular > price;
  const discount = known ? Math.round((1 - price / regular) * 100) : 0;
  const free = Boolean(body?.shipping?.free_shipping);
  const official = Boolean(body?.official_store_id);
  return {
    id: itemId, query, title: body?.title || `${query} — destaque #${rank}`,
    price, original_price: known ? regular : null, discount, discount_known: known,
    permalink: body?.permalink || productLink(itemId), thumbnail: String(body?.thumbnail || '').replace(/^http:/, 'https:'),
    free_shipping: free, sold_quantity: 0, official_store: official,
    score: scoreOf(discount, free, official, rank), affiliate_url: '', status: 'pending',
    found_at: new Date().toISOString(), source: 'mais_vendidos_item', rank
  };
}

async function discoverOffers(query) {
  const stats = { category: '', brand: '', highlights: 0, productTypes: 0, itemTypes: 0, userProductTypes: 0, resolved: 0, discounted: 0 };
  const domain = await discoverDomain(query);
  stats.category = domain.categoryName || domain.categoryId;
  stats.brand = domain.brandName || '';

  let h;
  if (domain.brandId) {
    try { h = await highlights(domain.categoryId, domain.brandId); }
    catch { h = await highlights(domain.categoryId); }
  } else {
    h = await highlights(domain.categoryId);
  }
  const content = Array.isArray(h?.content) ? h.content : [];
  stats.highlights = content.length;
  const itemIds = content.filter(x => x.type === 'ITEM').map(x => x.id);
  const bulk = await itemBulk(itemIds);
  const out = [];

  for (const row of content) {
    const rank = Number(row.position || 20);
    try {
      if (row.type === 'PRODUCT') {
        stats.productTypes++;
        const prod = await productDetail(row.id);
        const winner = prod?.buy_box_winner;
        if (!winner?.item_id) continue;
        if (domain.brandId && !titleMatches(prod.name || prod.family_name, query)) continue;
        const sale = await salePrice(winner.item_id);
        const p = fromWinner(prod, winner, query, rank, sale);
        if (p) { out.push(p); stats.resolved++; if (p.discount > 0) stats.discounted++; }
      } else if (row.type === 'ITEM') {
        stats.itemTypes++;
        const body = bulk.get(row.id);
        if (body?.title && !titleMatches(body.title, query) && !domain.brandId) continue;
        const sale = await salePrice(row.id);
        const p = fromItem(row.id, body, query, rank, sale);
        if (p) { out.push(p); stats.resolved++; if (p.discount > 0) stats.discounted++; }
      } else if (row.type === 'USER_PRODUCT') {
        stats.userProductTypes++;
      }
    } catch (e) {
      console.log(`[RESOLVE ${row.type} ${row.id}]`, e.message);
    }
  }

  return { items: out, stats, domain };
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
  let added = 0, checked = 0, withDiscount = 0, passed = 0, highlightsCount = 0;
  const errors = [], notes = [];
  for (const w of state.watchlists.filter(x => x.enabled)) {
    try {
      const result = await discoverOffers(w.query);
      const products = result.items;
      highlightsCount += result.stats.highlights;
      checked += products.length;
      withDiscount += products.filter(p => p.discount_known && p.discount > 0).length;
      notes.push(`${w.query}: ${result.stats.category}${result.stats.brand ? ` / ${result.stats.brand}` : ''}, ${result.stats.highlights} destaques, ${result.stats.resolved} com preço`);
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
  state.lastScanMessage = `${added} novas promoções; ${highlightsCount} destaques oficiais; ${checked} produtos com preço; ${withDiscount} com desconto; ${passed} passaram os filtros (mín. ${Number(state.settings.minDiscount || 0)}%).${notes.length ? ` ${notes.join(' | ')}` : ''}${errors.length ? ` Erros: ${errors.join(' | ')}` : ''}`;
  save();
  console.log('[SCAN]', state.lastScanMessage);
  return { added, highlightsCount, checked, withDiscount, passed, errors, notes, at: state.lastScanAt };
}

function publicState() {
  return {
    settings: state.settings, watchlists: state.watchlists, queue: state.queue,
    lastScanAt: state.lastScanAt, lastScanMessage: state.lastScanMessage,
    tokenConfigured: connected(), oauthReady: oauthReady(), oauthUserId: state.oauth?.user_id || null,
    oauthExpiresAt: state.oauth?.expires_at || 0, redirectUri: ML_REDIRECT_URI,
    searchMode: 'official_highlights_v4'
  };
}

let timer;
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (state.settings.autoScan && connected()) scan().catch(e => console.log('[AUTO]', e.message));
  }, Math.max(5, Number(state.settings.scanMinutes || 15)) * 60000);
}
schedule();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, tokenConfigured: connected(), oauthReady: oauthReady(), scanMinutes: state.settings.scanMinutes, searchMode: 'official_highlights_v4' });

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
        storeToken(d); state.oauth_state = null; save();
        html = '<p style="color:#8df0aa;font-size:20px">✅ Mercado Livre conectado com sucesso!</p>';
      } catch (e) { html = `<p style="color:#ff8b8b">❌ ${String(e.message).replace(/[<>]/g, '')}</p>`; }
      return send(res, 200, `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d11;color:#fff;padding:40px"><h1>🔥 Caça Promo ML</h1>${html}<p><a style="color:#ffe000" href="/">Voltar ao painel</a></p></body>`, 'text/html; charset=utf-8');
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req, res)) return;
      if (url.pathname === '/api/admin/state' && req.method === 'GET') return json(res, 200, publicState());
      if (url.pathname === '/api/admin/oauth/start' && req.method === 'POST') {
        if (!oauthReady()) return json(res, 400, { error: 'Faltam credenciais do Mercado Livre no Render.' });
        const value = crypto.randomBytes(24).toString('hex');
        state.oauth_state = { value, expires_at: Date.now() + 10 * 60 * 1000 }; save();
        const u = new URL('https://auth.mercadolivre.com.br/authorization');
        u.searchParams.set('response_type', 'code'); u.searchParams.set('client_id', ML_CLIENT_ID);
        u.searchParams.set('redirect_uri', ML_REDIRECT_URI); u.searchParams.set('state', value);
        return json(res, 200, { authUrl: u.toString() });
      }
      if (url.pathname === '/api/admin/oauth/disconnect' && req.method === 'POST') {
        state.oauth = structuredClone(defaults.oauth); state.oauth_state = null; save();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/admin/scan' && req.method === 'POST') return json(res, 200, await scan());
      if (url.pathname === '/api/admin/settings' && req.method === 'POST') {
        state.settings = { ...state.settings, ...await readBody(req) }; save(); schedule();
        return json(res, 200, state.settings);
      }
      if (url.pathname === '/api/admin/watchlists' && req.method === 'POST') {
        const b = await readBody(req), q = String(b.query || '').trim();
        if (!q) return json(res, 400, { error: 'Busca vazia.' });
        if (!state.watchlists.some(w => w.query.toLowerCase() === q.toLowerCase())) state.watchlists.push({ id: String(Date.now()), query: q, enabled: true });
        save(); return json(res, 200, state.watchlists);
      }
      let m = url.pathname.match(/^\/api\/admin\/watchlists\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        state.watchlists = state.watchlists.filter(w => w.id !== decodeURIComponent(m[1])); save();
        return json(res, 200, state.watchlists);
      }
      m = url.pathname.match(/^\/api\/admin\/queue\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        const id = decodeURIComponent(m[1]), p = state.queue.find(x => x.id === id);
        if (!p) return json(res, 404, { error: 'Produto não encontrado.' });
        const b = await readBody(req);
        if ('affiliate_url' in b) p.affiliate_url = String(b.affiliate_url || '').trim();
        if ('status' in b) p.status = String(b.status || 'pending');
        save(); return json(res, 200, p);
      }
      if (m && req.method === 'DELETE') {
        state.queue = state.queue.filter(x => x.id !== decodeURIComponent(m[1])); save();
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
  console.log(`Caça Promo ML 4.0: http://localhost:${PORT}`);
  console.log('Busca: categoria + mais vendidos + preços oficiais');
  if (state.settings.autoScan && connected()) scan().catch(e => console.log('[START]', e.message));
});
