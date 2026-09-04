const fs = require('fs');
const path = require('path');
const Module = require('module');

const basePath = path.join(__dirname, 'server6.js');
let source = fs.readFileSync(basePath, 'utf8');

const startMarker = 'async function resolveCatalogProduct(productId, query, rank, stats, depth, visited) {';
const endMarker = "\n}\n`;\nsource = replaceBetween(source, 'async function itemBulk(ids) {'";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('resolveCatalogProduct não encontrado em server6.js');

const replacement = `async function resolveCatalogProduct(productId, query, rank, stats, depth, visited) {
  depth = Number(depth || 0);
  visited = visited || new Set();
  if (!productId || visited.has(productId)) return null;
  if (Number(stats.catalogCalls || 0) >= 55) return null;
  visited.add(productId);
  stats.catalogCalls = Number(stats.catalogCalls || 0) + 1;
  if (depth > 0) stats.childProductsChecked = Number(stats.childProductsChecked || 0) + 1;

  let prod;
  try {
    prod = await productDetail(productId);
  } catch (e) {
    stats.catalogFailures = Number(stats.catalogFailures || 0) + 1;
    console.log('[CATALOGO ' + productId + ']', e.message);
    return null;
  }

  const winner = prod && prod.buy_box_winner;
  if (winner && winner.item_id && Number(winner.price || 0) > 0) {
    const sale = await salePrice(winner.item_id);
    const p = fromWinner(prod, winner, query, rank, sale);
    if (p) return p;
  }

  if (depth < 2) {
    const childrenRaw = Array.isArray(prod && prod.children_ids) ? prod.children_ids : [];
    const children = childrenRaw.map(function(c){ return typeof c === 'string' ? c : c && c.id; }).filter(Boolean).slice(0, 3);
    for (const childId of children) {
      if (Number(stats.catalogCalls || 0) >= 55) break;
      await sleep(120);
      const p = await resolveCatalogProduct(childId, query, rank, stats, depth + 1, visited);
      if (p) return p;
    }
  }

  try {
    stats.pdpCalls = Number(stats.pdpCalls || 0) + 1;
    const comp = await mlGet('https://api.mercadolibre.com/products/' + encodeURIComponent(productId) + '/items', 2);
    const results = Array.isArray(comp && comp.results) ? comp.results : [];
    stats.pdpOffers = Number(stats.pdpOffers || 0) + results.length;
    if (results.length) {
      const enriched = [];
      for (const c of results.slice(0, 8)) {
        if (!c || !c.item_id || !Number(c.price || 0)) continue;
        let sale = null;
        try { sale = await salePrice(c.item_id); } catch {}
        const price = Number(sale && sale.amount || c.price || 0);
        const regular = Number(sale && sale.regular_amount || c.original_price || 0);
        if (!price) continue;
        const known = regular > price;
        const discount = known ? Math.round((1 - price / regular) * 100) : 0;
        enriched.push({ c: c, price: price, regular: regular, known: known, discount: discount });
      }
      enriched.sort(function(a,b){
        if (b.discount !== a.discount) return b.discount - a.discount;
        const af = a.c && a.c.shipping && a.c.shipping.free_shipping ? 1 : 0;
        const bf = b.c && b.c.shipping && b.c.shipping.free_shipping ? 1 : 0;
        if (bf !== af) return bf - af;
        return a.price - b.price;
      });
      const best = enriched[0];
      if (best) {
        const c = best.c;
        const free = Boolean(c.shipping && c.shipping.free_shipping);
        const official = Boolean(c.official_store_id);
        return {
          id: c.item_id,
          query: query,
          title: prod && (prod.name || prod.family_name) || c.item_id,
          price: best.price,
          original_price: best.known ? best.regular : null,
          discount: best.discount,
          discount_known: best.known,
          permalink: prod && prod.permalink || productLink(c.item_id),
          thumbnail: String(prod && prod.pictures && prod.pictures[0] && (prod.pictures[0].url || prod.pictures[0].secure_url) || '').replace(/^http:/, 'https:'),
          free_shipping: free,
          sold_quantity: Number(c.sold_quantity || 0),
          official_store: official,
          score: scoreOf(best.discount, free, official, rank),
          affiliate_url: '', status: 'pending', found_at: new Date().toISOString(),
          source: 'pdp_competition', rank: rank
        };
      }
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
  .replace("'User-Agent': 'CacaPromoML/4.4'", "'User-Agent': 'CacaPromoML/4.5'")
  .replace("searchMode: 'official_highlights_v44'", "searchMode: 'official_highlights_v45'")
  .replace("searchMode: 'official_highlights_v44'", "searchMode: 'official_highlights_v45'")
  .replace('Caça Promo ML 4.4:', 'Caça Promo ML 4.5:')
  .replace('${result.stats.catalogFailures} falhas catálogo`);', '${result.stats.catalogFailures} falhas catálogo, ${result.stats.pdpOffers || 0} ofertas PDP, ${result.stats.pdpEmpty || 0} PDP vazios, ${result.stats.pdpFailures || 0} falhas PDP`);');

const runtime = new Module(basePath, module);
runtime.filename = basePath;
runtime.paths = module.paths;
runtime._compile(source, basePath);
