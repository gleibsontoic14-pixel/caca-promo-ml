const fs = require('fs');
const path = require('path');
const Module = require('module');

const basePath = path.join(__dirname, 'server6.js');
let source = fs.readFileSync(basePath, 'utf8');

// A API pode retornar 403/404 em recursos que não pertencem ao usuário.
// Evita repetir chamadas permanentes e impede que o painel fique preso em “Buscando promoções…”.
source = source.replace(
  "let source = fs.readFileSync(serverPath, 'utf8');",
  "let source = fs.readFileSync(serverPath, 'utf8');\nsource = source.replace('async function mlGet(url, attempts = 3) {', 'async function mlGet(url, attempts = 1) {');"
);
source = source.replace(
  "const content = Array.isArray(h && h.content) ? h.content : [];",
  "const content = (Array.isArray(h && h.content) ? h.content : []).slice(0, 10);"
);
source = source.replace(
  "stats.userProductTypes++;\n        const up = await userProductDetail(row.id);",
  "stats.userProductTypes++;\n        continue;\n        const up = await userProductDetail(row.id);"
);

const startMarker = 'async function resolveCatalogProduct(productId, query, rank, stats, depth, visited) {';
const endMarker = "\n}\n`;\nsource = replaceBetween(source, 'async function itemBulk(ids) {'";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('resolveCatalogProduct não encontrado em server6.js');

const replacement = `async function resolveCatalogProduct(productId, query, rank, stats, depth, visited) {
  depth = Number(depth || 0);
  visited = visited || new Set();
  if (!productId || visited.has(productId)) return null;
  if (Number(stats.catalogCalls || 0) >= 26) return null;
  visited.add(productId);
  stats.catalogCalls = Number(stats.catalogCalls || 0) + 1;
  if (depth > 0) stats.childProductsChecked = Number(stats.childProductsChecked || 0) + 1;

  let prod;
  try {
    prod = await Promise.race([
      productDetail(productId),
      new Promise(function(_, reject){ setTimeout(function(){ reject(new Error('Catálogo timeout')); }, 1800); })
    ]);
  } catch (e) {
    stats.catalogFailures = Number(stats.catalogFailures || 0) + 1;
    console.log('[CATALOGO ' + productId + ']', e.message);
    return null;
  }

  const winner = prod && prod.buy_box_winner;
  if (winner && winner.item_id && Number(winner.price || 0) > 0) {
    const p = fromWinner(prod, winner, query, rank, null);
    if (p) return p;
  }

  if (depth < 1) {
    const childrenRaw = Array.isArray(prod && prod.children_ids) ? prod.children_ids : [];
    const children = childrenRaw.map(function(c){ return typeof c === 'string' ? c : c && c.id; }).filter(Boolean).slice(0, 2);
    for (const childId of children) {
      if (Number(stats.catalogCalls || 0) >= 26) break;
      const p = await resolveCatalogProduct(childId, query, rank, stats, depth + 1, visited);
      if (p) return p;
    }
  }

  try {
    stats.pdpCalls = Number(stats.pdpCalls || 0) + 1;
    const pdpUrl = 'https://api.mercadolibre.com/products/' + encodeURIComponent(productId) + '/items';
    const comp = await Promise.race([
      mlGet(pdpUrl, 1),
      new Promise(function(_, reject){ setTimeout(function(){ reject(new Error('PDP timeout')); }, 1800); })
    ]);
    const results = Array.isArray(comp && comp.results) ? comp.results : [];
    stats.pdpOffers = Number(stats.pdpOffers || 0) + results.length;
    for (const c of results.slice(0, 5)) {
      if (!c || !c.item_id || !Number(c.price || 0)) continue;
      const price = Number(c.price || 0);
      const regular = Number(c.original_price || 0);
      const known = regular > price;
      const discount = known ? Math.round((1 - price / regular) * 100) : 0;
      const free = Boolean(c.shipping && c.shipping.free_shipping);
      const official = Boolean(c.official_store_id);
      return {
        id: c.item_id,
        query: query,
        title: prod && (prod.name || prod.family_name) || c.item_id,
        price: price,
        original_price: known ? regular : null,
        discount: discount,
        discount_known: known,
        permalink: prod && prod.permalink || productLink(c.item_id),
        thumbnail: String(prod && prod.pictures && prod.pictures[0] && (prod.pictures[0].url || prod.pictures[0].secure_url) || '').replace(/^http:/, 'https:'),
        free_shipping: free,
        sold_quantity: Number(c.sold_quantity || 0),
        official_store: official,
        score: scoreOf(discount, free, official, rank),
        affiliate_url: '', status: 'pending', found_at: new Date().toISOString(),
        source: 'pdp_competition', rank: rank
      };
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/404|No winners found/i.test(msg)) stats.pdpEmpty = Number(stats.pdpEmpty || 0) + 1;
    else stats.pdpFailures = Number(stats.pdpFailures || 0) + 1;
    console.log('[PDP ' + productId + ']', msg);
  }

  return null;
}`;

source = source.slice(0, start) + replacement + source.slice(end + 2);
source = source
  .replace("'User-Agent': 'CacaPromoML/4.4'", "'User-Agent': 'CacaPromoML/4.7'")
  .replace("searchMode: 'official_highlights_v44'", "searchMode: 'official_highlights_v47'")
  .replace("searchMode: 'official_highlights_v44'", "searchMode: 'official_highlights_v47'")
  .replace('Caça Promo ML 4.4:', 'Caça Promo ML 4.7:')
  .replace('${result.stats.catalogFailures} falhas catálogo`);', '${result.stats.catalogFailures} falhas catálogo, ${result.stats.pdpOffers || 0} ofertas PDP, ${result.stats.pdpEmpty || 0} PDP vazios, ${result.stats.pdpFailures || 0} falhas PDP`);');

const runtime = new Module(basePath, module);
runtime.filename = basePath;
runtime.paths = module.paths;
runtime._compile(source, basePath);
