const fs = require('fs');
const path = require('path');
const Module = require('module');

const serverPath = path.join(__dirname, 'server3.js');
let source = fs.readFileSync(serverPath, 'utf8');

const oldBlock = [
"async function discoverDomain(query) {",
"  const u = new URL('https://api.mercadolibre.com/sites/MLB/domain_discovery/search');",
"  u.searchParams.set('q', query);",
"  u.searchParams.set('limit', '3');",
"  const d = await mlGet(u);",
"  const best = Array.isArray(d) ? d[0] : null;",
"  if (!best?.category_id) throw new Error('Não consegui identificar a categoria da busca.');",
"  const brand = (best.attributes || []).find(a => a.id === 'BRAND' && a.value_id);",
"  return { categoryId: best.category_id, categoryName: best.category_name || '', domainId: best.domain_id || '', brandId: brand?.value_id || '', brandName: brand?.value_name || '' };",
"}"
].join('\n');

const newBlock = [
"function normalizedText(v) {",
"  return String(v || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');",
"}",
"function queryProfile(query) {",
"  const q = normalizedText(query);",
"  const profiles = [",
"    { match: /\\b(celular|smartphone|iphone|galaxy|motorola|xiaomi)\\b/, variants: ['smartphone celular 128gb', 'telefone celular smartphone'], accepted: ['celular','smartphone','telefone'] },",
"    { match: /\\b(funko|funko pop)\\b/, variants: ['boneco colecionavel funko pop', 'figura colecionavel funko pop'], accepted: ['boneco','figura','colecion','funko'] },",
"    { match: /\\b(air ?fryer|fritadeira)\\b/, variants: ['fritadeira eletrica air fryer', 'air fryer fritadeira sem oleo'], accepted: ['fritadeira','eletrodom'] },",
"    { match: /\\b(fone|headphone|earbud|bluetooth)\\b/, variants: ['fone de ouvido bluetooth', 'headphone bluetooth'], accepted: ['fone','headphone','auricular'] },",
"    { match: /\\b(smart ?tv|televisao|tv)\\b/, variants: ['televisao smart tv', 'smart tv led'], accepted: ['televis','tv'] },",
"    { match: /\\b(notebook|laptop)\\b/, variants: ['notebook laptop computador portatil'], accepted: ['notebook','laptop','computador'] },",
"    { match: /\\b(perfume|fragrancia)\\b/, variants: ['perfume fragrancia', 'perfume eau de parfum'], accepted: ['perfume','fragr'] },",
"    { match: /\\b(tenis|sneaker)\\b/, variants: ['tenis calcado esportivo', 'tenis masculino'], accepted: ['tenis','calcado'] },",
"    { match: /\\b(console|playstation|ps5|xbox|nintendo switch)\\b/, variants: ['console videogame', 'console playstation xbox nintendo'], accepted: ['console','videogame','games'] }",
"  ];",
"  return profiles.find(p => p.match.test(q)) || { variants: [String(query || '').trim()], accepted: [] };",
"}",
"function domainCandidateText(c) {",
"  const attrs = (c.attributes || []).map(a => String(a.value_name || '') + ' ' + String(a.name || '')).join(' ');",
"  return normalizedText(String(c.category_name || '') + ' ' + String(c.domain_id || '') + ' ' + attrs);",
"}",
"function candidateScore(c, query, accepted) {",
"  const text = domainCandidateText(c);",
"  let score = 0;",
"  for (const a of accepted) if (text.includes(a)) score += 20;",
"  for (const t of usefulTokens(query)) if (text.includes(t)) score += 5;",
"  const prob = Number(c.prediction_probability || c.probability || 0);",
"  score += Math.round(prob * 10);",
"  return score;",
"}",
"async function discoverDomain(query) {",
"  const profile = queryProfile(query);",
"  const variants = [...new Set([String(query || '').trim(), ...profile.variants].filter(Boolean))];",
"  const candidates = [];",
"  for (const q of variants) {",
"    try {",
"      const u = new URL('https://api.mercadolibre.com/sites/MLB/domain_discovery/search');",
"      u.searchParams.set('q', q);",
"      u.searchParams.set('limit', '5');",
"      const d = await mlGet(u);",
"      for (const c of Array.isArray(d) ? d : []) if (c?.category_id) candidates.push(c);",
"    } catch (e) {",
"      console.log('[DOMAIN]', q, e.message);",
"    }",
"  }",
"  if (!candidates.length) throw new Error('Não consegui identificar a categoria da busca.');",
"  const ranked = candidates.map(c => ({ c, score: candidateScore(c, query, profile.accepted) })).sort((a,b) => b.score - a.score);",
"  let best = ranked[0]?.c;",
"  if (profile.accepted.length) {",
"    const valid = ranked.find(x => profile.accepted.some(a => domainCandidateText(x.c).includes(a)));",
"    if (!valid) throw new Error('Categoria incoerente para "' + query + '"; a busca foi bloqueada para evitar resultados errados.');",
"    best = valid.c;",
"  }",
"  const brand = (best.attributes || []).find(a => a.id === 'BRAND' && a.value_id);",
"  return {",
"    categoryId: best.category_id,",
"    categoryName: best.category_name || '',",
"    domainId: best.domain_id || '',",
"    brandId: brand?.value_id || '',",
"    brandName: brand?.value_name || ''",
"  };",
"}"
].join('\n');

if (!source.includes(oldBlock)) {
  throw new Error('Não encontrei o bloco discoverDomain esperado em server3.js.');
}

source = source.replace(oldBlock, newBlock)
  .replace("'User-Agent': 'CacaPromoML/4.0'", "'User-Agent': 'CacaPromoML/4.1'")
  .replace('Caça Promo ML 4.0:', 'Caça Promo ML 4.1:');

const runtime = new Module(serverPath, module);
runtime.filename = serverPath;
runtime.paths = module.paths;
runtime._compile(source, serverPath);
