const fs = require('fs');
const path = require('path');
const Module = require('module');

const serverPath = path.join(__dirname, 'server3.js');
let source = fs.readFileSync(serverPath, 'utf8');

const startMarker = 'async function discoverDomain(query) {';
const endMarker = '\n\nasync function highlights(';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('Bloco discoverDomain não encontrado.');

const newBlock = `function normalizedText(v) {
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
  const prob = Number(c.prediction_probability || c.probability || 0);
  score += Math.round(prob * 10);
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
    } catch (e) {
      console.log('[DOMAIN]', q, e.message);
    }
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
  return {
    categoryId: best.category_id,
    categoryName: best.category_name || '',
    domainId: best.domain_id || '',
    brandId: brand && brand.value_id || '',
    brandName: brand && brand.value_name || ''
  };
}`;

source = source.slice(0, start) + newBlock + source.slice(end);
source = source
  .replace("'User-Agent': 'CacaPromoML/4.0'", "'User-Agent': 'CacaPromoML/4.2'")
  .replace("searchMode: 'official_highlights_v4'", "searchMode: 'official_highlights_v42'")
  .replace("searchMode: 'official_highlights_v4'", "searchMode: 'official_highlights_v42'")
  .replace('Caça Promo ML 4.0:', 'Caça Promo ML 4.2:');

const runtime = new Module(serverPath, module);
runtime.filename = serverPath;
runtime.paths = module.paths;
runtime._compile(source, serverPath);
