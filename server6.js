const fs = require('fs');
const path = require('path');
const Module = require('module');

const serverPath = path.join(__dirname, 'server3.js');
let source = fs.readFileSync(serverPath, 'utf8');

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Bloco não encontrado: ' + startMarker);
  return text.slice(0, start) + replacement + text.slice(end);
}

const domainBlock = `function normalizedText(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
}
function queryProfile(query) {
  const q = normalizedText(query);
  const profiles = [
    { match: /\\b(celular|smartphone|iphone|galaxy|motorola|xiaomi)\\b/, variants: ['smartphone celular 128gb', 'telefone celular smartphone'], accepted: ['celular','smartphone','telefone'] },
    { match: /\\b(funko|funko pop)\\b/, variants: ['boneco colecionavel funko pop', 'figura colecionavel funko pop'], accepted: ['boneco','figura','colecion','funko'] },
    { match: /\\b(air ?fryer|fritadeira)\\b/, variants: ['fritadeira eletrica air fryer', 'air fryer fritadeira sem oleo'], accepted: ['fritadeira','eletrodom'] },
    { match: /\\b(fone|headphone|earbud|bluetooth)\\b/, variants: ['fone de ouvido bluetooth', 'headphone bluetooth'], accepted: ['fone','headphone','auricular'] },
    { match: /\\b(smart ?tv|televisao|tv)\\b/, variants: ['televisao smart tv', 'smart tv led'], accepted: ['televis','tv'] },
    { match: /\\b(notebook|laptop)\\b/, variants: ['notebook laptop computador portatil'], accepted: ['notebook','laptop','computador'] },
    { match: /\\b(perfume|fragrancia)\\b/, variants: ['perfume fragrancia', 'perfume eau de parfum'], accepted: ['perfume','fragr'] },
    { match: /\\b(tenis|sneaker)\\b/, variants: ['tenis calcado esportivo', 'tenis masculino'], accepted: ['tenis','calcado'] },
    { match: /\\b(console|playstation|ps5|xbox|nintendo switch)\\b/, variants: ['console videogame', 'console playstation xbox nintendo'], accepted: ['console','videogame','games'] }
  ];
  return profiles.find(function(p){ return p.match.test(q); }) || { variants: [String(query || '').trim()], accepted: [] };
}
function domainCandidateText(c) {
  const attrs = (c.attributes || []).map(function(a){ return String(a.value_name || '') + ' ' + String(a.name || ''); }).join(' ');
  return normalizedText(String(c.category_name || '') + ' ' + String(c.domain_id || '') + ' ' + attrs);
}
function candidateScore(c, query, accepted) {
  const text = domainCandidateText(c);
  let score = 0;
  for (const a of accepted) if (text.includes(a)) score += 20;
  for (const t of usefulTokens(query)) if (text.includes(t)) score += 5;
  score += Math.round(Number(c.prediction_probability || c.probability || 0) * 10);
  return score;
}
async function discoverDomain(query) {
  const profile = queryProfile(query);
  const variants = Array.from(new Set([String(query || '').trim()].concat(profile.variants).filter(Boolean)));
  const candidates = [];
  for (const q of variants) {
    try {
      const u = new URL('https://api.mercadolibre.com/sites/MLB/domain_discovery/search');
      u.searchParams.set('q', q);
      u.searchParams.set('limit', '5');
      const d = await mlGet(u);
      for (const c of Array.isArray(d) ? d : []) if (c && c.category_id) candidates.push(c);
    } catch (e) { console.log('[DOMAIN]', q, e.message); }
  }
  if (!candidates.length) throw new Error('Não consegui identificar a categoria da busca.');
  const ranked = candidates.map(function(c){ return { c: c, score: candidateScore(c, query, profile.accepted) }; }).sort(function(a,b){ return b.score - a.score; });
  let best = ranked[0] && ranked[0].c;
  if (profile.accepted.length) {
    const valid = ranked.find(function(x){ return profile.accepted.some(function(a){ return domainCandidateText(x.c).includes(a); }); });
    if (!valid) throw new Error('Categoria incoerente para ' + query + '; busca bloqueada para evitar resultados errados.');
    best = valid.c;
  }
  const brand = (best.attributes || []).find(function(a){ return a.id === 'BRAND' && a.value_id; });
  return { categoryId: best.category_id, categoryName: best.category_name || '', domainId: best.domain_id || '', brandId: brand && brand.value_id || '', brandName: brand && brand.value_name || '' };
}
`;
source = replaceBetween(source, 'async function discoverDomain(query) {', '\n\nasync function highlights(', domainBlock);

const itemBlock = `async function itemBulk(ids) {
  if (!ids.length) return new Map();
  try {
    const u = new URL('https://api.mercadolibre.com/items/bulk');
    u.searchParams.set('ids', ids.slice(0, 20).join(','));
    u.searchParams.set('attributes', 'body.id,body.title,body.permalink,body.thumbnail,body.shipping,body.official_store_id,body.price,body.base_price,body.original_price,body.status,body.user_product_id');
    const d = await mlGet(u, 2);
    const map = new Map();
    for (const row of Array.isArray(d) ? d : []) {
      if (Number(row.status_code || row.code) === 200 && row.body && row.body.id) map.set(row.body.id, row.body);
    }
    return map;
  } catch (e) {
    console.log('[ITEM BULK]', e.message);
    return new Map();
  }
}
async function userProductDetail(userProductId) {
  return mlGet('https://api.mercadolibre.com/user-products/' + encodeURIComponent(userProductId), 2);
}
async function userProductItemIds(sellerId, userProductId) {
  const u = new URL('https://api.mercadolibre.com/users/' + encodeURIComponent(sellerId) + '/items/search');
  u.searchParams.set('user_product_id', userProductId);
  u.searchParams.set('status', 'active');
  u.searchParams.set('limit', '20');
  const d = await mlGet(u, 2);
  return Array.isArray(d && d.results) ? d.results : [];
}
`;
source = replaceBetween(source, 'async function itemBulk(ids) {', '\n\nfunction fromWinner(', itemBlock);

const fromItemBlock = `function fromItem(itemId, body, query, rank, sale, fallbackTitle, fallbackThumb) {
  const salePriceValue = Number(sale && sale.amount || 0);
  const bodyPriceValue = Number(body && (body.price || body.base_price) || 0);
  const price = salePriceValue > 0 ? salePriceValue : bodyPriceValue;
  if (!price) return null;
  const regular = Number(sale && sale.regular_amount || body && body.original_price || 0);
  const known = regular > price;
  const discount = known ? Math.round((1 - price / regular) * 100) : 0;
  const free = Boolean(body && body.shipping && body.shipping.free_shipping);
  const official = Boolean(body && body.official_store_id);
  return {
    id: itemId, query: query, title: body && body.title || fallbackTitle || (query + ' — destaque #' + rank),
    price: price, original_price: known ? regular : null, discount: discount, discount_known: known,
    permalink: body && body.permalink || productLink(itemId),
    thumbnail: String(body && body.thumbnail || fallbackThumb || '').replace(/^http:/, 'https:'),
    free_shipping: free, sold_quantity: 0, official_store: official,
    score: scoreOf(discount, free, official, rank), affiliate_url: '', status: 'pending',
    found_at: new Date().toISOString(), source: 'mais_vendidos_item', rank: rank
  };
}
`;
source = replaceBetween(source, 'function fromItem(itemId, body, query, rank, sale) {', '\n\nasync function discoverOffers(', fromItemBlock);

const discoverBlock = `async function discoverOffers(query) {
  const stats = { category: '', brand: '', highlights: 0, productTypes: 0, itemTypes: 0, userProductTypes: 0, resolved: 0, discounted: 0, upResolved: 0 };
  const domain = await discoverDomain(query);
  stats.category = domain.categoryName || domain.categoryId;
  stats.brand = domain.brandName || '';

  let h;
  if (domain.brandId) {
    try { h = await highlights(domain.categoryId, domain.brandId); }
    catch { h = await highlights(domain.categoryId); }
  } else { h = await highlights(domain.categoryId); }

  const content = Array.isArray(h && h.content) ? h.content : [];
  stats.highlights = content.length;
  const directItemIds = content.filter(function(x){ return x.type === 'ITEM'; }).map(function(x){ return x.id; });
  const directBulk = await itemBulk(directItemIds);
  const out = [];

  for (const row of content) {
    const rank = Number(row.position || 20);
    try {
      if (row.type === 'PRODUCT') {
        stats.productTypes++;
        const prod = await productDetail(row.id);
        const winner = prod && prod.buy_box_winner;
        if (!winner || !winner.item_id) continue;
        const sale = await salePrice(winner.item_id);
        const p = fromWinner(prod, winner, query, rank, sale);
        if (p) { out.push(p); stats.resolved++; if (p.discount > 0) stats.discounted++; }
      } else if (row.type === 'ITEM') {
        stats.itemTypes++;
        const body = directBulk.get(row.id);
        const sale = await salePrice(row.id);
        const p = fromItem(row.id, body, query, rank, sale);
        if (p) { out.push(p); stats.resolved++; if (p.discount > 0) stats.discounted++; }
      } else if (row.type === 'USER_PRODUCT') {
        stats.userProductTypes++;
        const up = await userProductDetail(row.id);
        const sellerId = up && up.user_id;
        if (!sellerId) continue;
        const ids = await userProductItemIds(sellerId, row.id);
        if (!ids.length) continue;
        const bulk = await itemBulk(ids);
        let best = null;
        for (const id of ids) {
          const body = bulk.get(id);
          if (!body || body.status && body.status !== 'active') continue;
          const p = fromItem(id, body, query, rank, null, up.name || up.family_name || '', up.pictures && up.pictures[0] && (up.pictures[0].url || up.pictures[0].secure_url) || '');
          if (p && (!best || p.price < best.price)) best = p;
        }
        if (best) { out.push(best); stats.resolved++; stats.upResolved++; if (best.discount > 0) stats.discounted++; }
      }
    } catch (e) {
      console.log('[RESOLVE ' + row.type + ' ' + row.id + ']', e.message);
    }
  }

  return { items: out, stats: stats, domain: domain };
}
`;
source = replaceBetween(source, 'async function discoverOffers(query) {', '\n\nfunction passesFilters(', discoverBlock);

source = source
  .replace("'User-Agent': 'CacaPromoML/4.0'", "'User-Agent': 'CacaPromoML/4.3'")
  .replace("searchMode: 'official_highlights_v4'", "searchMode: 'official_highlights_v43'")
  .replace("searchMode: 'official_highlights_v4'", "searchMode: 'official_highlights_v43'")
  .replace('Caça Promo ML 4.0:', 'Caça Promo ML 4.3:')
  .replace("notes.push(`${w.query}: ${result.stats.category}${result.stats.brand ? ` / ${result.stats.brand}` : ''}, ${result.stats.highlights} destaques, ${result.stats.resolved} com preço`);", "notes.push(`${w.query}: ${result.stats.category}${result.stats.brand ? ` / ${result.stats.brand}` : ''}, ${result.stats.highlights} destaques (${result.stats.userProductTypes} UP / ${result.stats.productTypes} catálogo / ${result.stats.itemTypes} itens), ${result.stats.resolved} com preço`);");

const runtime = new Module(serverPath, module);
runtime.filename = serverPath;
runtime.paths = module.paths;
runtime._compile(source, serverPath);
