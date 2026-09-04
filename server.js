const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {URL}=require('url');

const PORT=Number(process.env.PORT||3000);
const HOST='0.0.0.0';
const ADMIN_KEY=process.env.ADMIN_KEY||'000';
const SCAN_MINUTES=Math.max(5,Number(process.env.SCAN_MINUTES||15));
const ML_CLIENT_ID=process.env.ML_CLIENT_ID||'';
const ML_CLIENT_SECRET=process.env.ML_CLIENT_SECRET||'';
const ML_REDIRECT_URI=process.env.ML_REDIRECT_URI||'https://caca-promo-ml.onrender.com/oauth/callback';
const ML_ACCESS_TOKEN_ENV=process.env.ML_ACCESS_TOKEN||'';
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const STATE_FILE=path.join(DATA_DIR,'state.json');
const PUBLIC_DIR=path.join(__dirname,'public');
fs.mkdirSync(DATA_DIR,{recursive:true});

const defaults={
  settings:{minDiscount:20,maxPrice:0,freeOnly:false,minScore:0,scanMinutes:SCAN_MINUTES,autoScan:true},
  watchlists:[{id:'inicial',query:'ofertas',enabled:true}],
  queue:[],seen:{},
  oauth:{access_token:'',refresh_token:'',expires_at:0,user_id:null},
  oauth_state:null,lastScanAt:null,lastScanMessage:'Ainda não executado.'
};

function load(){
  try{
    const d=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    return {...structuredClone(defaults),...d,settings:{...defaults.settings,...(d.settings||{})},oauth:{...defaults.oauth,...(d.oauth||{})}};
  }catch{return structuredClone(defaults)}
}
let state=load();
function save(){fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2))}
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, X-Admin-Key'});res.end(body)}
function json(res,status,data){send(res,status,JSON.stringify(data))}
function admin(req,res){if((req.headers['x-admin-key']||'')!==ADMIN_KEY){json(res,401,{error:'Senha ADMIN inválida.'});return false}return true}
async function body(req){return new Promise((ok,bad)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e6)req.destroy()});req.on('end',()=>{try{ok(s?JSON.parse(s):{})}catch(e){bad(e)}})})}
function staticFile(url,res){let p=url.pathname==='/'?'/index.html':url.pathname;p=path.normalize(p).replace(/^(\.\.[/\\])+/,'');const f=path.join(PUBLIC_DIR,p);if(!f.startsWith(PUBLIC_DIR))return send(res,403,'Forbidden','text/plain');fs.readFile(f,(e,d)=>{if(e)return send(res,404,'Not found','text/plain');const ext=path.extname(f),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};send(res,200,d,types[ext]||'application/octet-stream')})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function oauthReady(){return!!(ML_CLIENT_ID&&ML_CLIENT_SECRET&&ML_REDIRECT_URI)}
function connected(){return!!(ML_ACCESS_TOKEN_ENV||state.oauth?.access_token)}
async function tokenRequest(params){const r=await fetch('https://api.mercadolibre.com/oauth/token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||d.error_description||d.error||`OAuth ${r.status}`);return d}
function storeToken(d){state.oauth={access_token:d.access_token||'',refresh_token:d.refresh_token||state.oauth?.refresh_token||'',expires_at:Date.now()+Math.max(0,Number(d.expires_in||21600)-120)*1000,user_id:d.user_id||state.oauth?.user_id||null};save()}
async function ensureToken(){if(ML_ACCESS_TOKEN_ENV)return ML_ACCESS_TOKEN_ENV;if(state.oauth?.access_token&&Number(state.oauth.expires_at||0)>Date.now())return state.oauth.access_token;if(state.oauth?.refresh_token&&oauthReady()){const d=await tokenRequest({grant_type:'refresh_token',client_id:ML_CLIENT_ID,client_secret:ML_CLIENT_SECRET,refresh_token:state.oauth.refresh_token});storeToken(d);return state.oauth.access_token}throw new Error('Mercado Livre não conectado. Use o botão Conectar Mercado Livre.')}
async function mlGet(url){
  const token=await ensureToken();
  let last='';
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'CacaPromoML/2.7',Authorization:`Bearer ${token}`}});
      const text=await r.text();last=text;
      if(r.ok){try{return JSON.parse(text)}catch{return{raw:text}}}
      if([429,500,502,503,504].includes(r.status)&&attempt<2){await sleep(400*(attempt+1));continue}
      throw new Error(`Mercado Livre API ${r.status}: ${String(text).slice(0,220)}`);
    }catch(e){
      last=e.message;
      if(attempt<2){await sleep(400*(attempt+1));continue}
      throw e;
    }
  }
  throw new Error(last||'Falha na API do Mercado Livre');
}

function searchTerms(q){const n=String(q||'').trim().toLowerCase();if(['ofertas','oferta','promo','promos','promoção','promoções','promocao','promocoes'].includes(n))return ['celular','air fryer','smart tv','fone bluetooth'];return [String(q||'').trim()]}
async function catalogSearch(term){const u=new URL('https://api.mercadolibre.com/products/search');u.searchParams.set('status','active');u.searchParams.set('site_id','MLB');u.searchParams.set('q',term);u.searchParams.set('limit','20');const d=await mlGet(u);return d.results||[]}
async function productDetail(productId){return mlGet(`https://api.mercadolibre.com/products/${encodeURIComponent(productId)}`)}

function promoFromProduct(prod,query){
  const w=prod?.buy_box_winner;
  if(!w||!w.item_id||!Number(w.price))return null;
  const price=Number(w.price||0);
  const original=Number(w.original_price||0);
  const discountKnown=original>price&&price>0;
  const discount=discountKnown?Math.round((1-price/original)*100):0;
  const free=!!w.shipping?.free_shipping;
  const official=!!w.official_store_id;
  const sold=Number(w.sold_quantity||prod.sold_quantity||0);
  const score=Math.round(Math.min(100,(discountKnown?discount*1.7:0)+Math.min(15,Math.log10(sold+1)*5)+(free?8:0)+(official?5:0)));
  const pic=prod.pictures?.[0]?.url||prod.pictures?.[0]?.secure_url||'';
  return {id:w.item_id,query,title:prod.name||prod.family_name||w.item_id,price,original_price:discountKnown?original:null,discount,discount_known:discountKnown,permalink:prod.permalink||`https://www.mercadolivre.com.br/p/${prod.id}`,thumbnail:String(pic).replace(/^http:/,'https:'),free_shipping:free,sold_quantity:sold,official_store:official,score,affiliate_url:'',status:'pending',found_at:new Date().toISOString(),catalog_product_id:prod.id};
}

async function addProductAndChildren(base,query,out,stats){
  if(!base?.id)return;
  let detail=base;
  let direct=promoFromProduct(detail,query);
  if(direct){if(!out.some(x=>x.id===direct.id))out.push(direct);stats.winners++;return}
  try{await sleep(120);detail=await productDetail(base.id);stats.details++;}
  catch(e){stats.failures++;console.log(`Produto ${base.id} ignorado: ${e.message}`);return}
  direct=promoFromProduct(detail,query);
  if(direct){if(!out.some(x=>x.id===direct.id))out.push(direct);stats.winners++;return}
  const children=Array.isArray(detail.children_ids)?detail.children_ids.slice(0,5):[];
  for(const childId of children){
    try{
      await sleep(160);
      const child=await productDetail(childId);stats.details++;
      const p=promoFromProduct(child,query);
      if(p&&!out.some(x=>x.id===p.id)){out.push(p);stats.winners++}
    }catch(e){stats.failures++;console.log(`Filho ${childId} ignorado: ${e.message}`)}
  }
}

async function marketplaceCandidates(query){
  const out=[];
  const seenProducts=new Set();
  const stats={catalog:0,details:0,winners:0,failures:0};
  for(const term of searchTerms(query)){
    const products=await catalogSearch(term);stats.catalog+=products.length;
    for(const base of products){
      if(!base?.id||seenProducts.has(base.id))continue;
      seenProducts.add(base.id);
      await addProductAndChildren(base,query,out,stats);
      if(out.length>=30)break;
    }
  }
  return{items:out,stats};
}

function pass(p){
  const s=state.settings;
  const discountPass=Number(s.minDiscount||0)<=0 ? true : (p.discount_known&&p.discount>=Number(s.minDiscount||0));
  return discountPass&&(!Number(s.maxPrice||0)||p.price<=Number(s.maxPrice))&&(!s.freeOnly||p.free_shipping)&&p.score>=Number(s.minScore||0);
}

async function scan(){
  let added=0,checked=0,withDiscount=0,passed=0,errors=[];
  let totals={catalog:0,details:0,winners:0,failures:0};
  for(const w of state.watchlists.filter(x=>x.enabled)){
    try{
      const result=await marketplaceCandidates(w.query),products=result.items;
      for(const k of Object.keys(totals))totals[k]+=Number(result.stats[k]||0);
      checked+=products.length;
      withDiscount+=products.filter(p=>p.discount_known&&p.discount>0).length;
      for(const p of products){if(!pass(p))continue;passed++;if(state.seen[p.id])continue;state.seen[p.id]=new Date().toISOString();state.queue.unshift(p);added++}
    }catch(e){errors.push(`${w.query}: ${e.message}`)}
  }
  state.queue=state.queue.slice(0,500);state.lastScanAt=new Date().toISOString();
  const f=state.settings;
  state.lastScanMessage=`${added} novas promoções; ${totals.catalog} resultados de catálogo; ${checked} com Buy Box; ${withDiscount} com desconto; ${passed} passaram os filtros (mín. ${Number(f.minDiscount||0)}%).${totals.failures?` ${totals.failures} consultas falharam temporariamente.`:''}${errors.length?` Erros: ${errors.join(' | ')}`:''}`;
  save();console.log(`[SCAN] ${state.lastScanMessage}`);
  return{added,checked,withDiscount,passed,errors,stats:totals,tokenConfigured:connected(),at:state.lastScanAt};
}
function pub(){return{settings:state.settings,watchlists:state.watchlists,queue:state.queue,lastScanAt:state.lastScanAt,lastScanMessage:state.lastScanMessage,tokenConfigured:connected(),oauthReady:oauthReady(),oauthUserId:state.oauth?.user_id||null,oauthExpiresAt:state.oauth?.expires_at||0,redirectUri:ML_REDIRECT_URI,searchMode:'product_buy_box_children_v2'}}
let timer;function schedule(){clearInterval(timer);timer=setInterval(()=>{if(state.settings.autoScan&&connected())scan().catch(e=>console.log('[AUTO]',e.message))},Math.max(5,Number(state.settings.scanMinutes||15))*60000)}schedule();

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host}`);
    if(req.method==='OPTIONS')return send(res,204,'');
    if(url.pathname==='/api/health')return json(res,200,{ok:true,tokenConfigured:connected(),oauthReady:oauthReady(),scanMinutes:state.settings.scanMinutes,searchMode:'product_buy_box_children_v2'});
    if(url.pathname==='/oauth/callback'){
      const code=url.searchParams.get('code'),error=url.searchParams.get('error'),returnedState=url.searchParams.get('state');let html='';
      try{if(error)throw new Error(error);if(!code)throw new Error('Código de autorização não recebido.');if(!state.oauth_state||returnedState!==state.oauth_state.value||Date.now()>state.oauth_state.expires_at)throw new Error('State OAuth inválido ou expirado. Tente conectar novamente.');const d=await tokenRequest({grant_type:'authorization_code',client_id:ML_CLIENT_ID,client_secret:ML_CLIENT_SECRET,code,redirect_uri:ML_REDIRECT_URI});storeToken(d);state.oauth_state=null;save();html='<p style="color:#8df0aa;font-size:20px">✅ Mercado Livre conectado com sucesso!</p><p>O bot já pode buscar promoções.</p>'}catch(e){html=`<p style="color:#ff8b8b;font-size:20px">❌ Não consegui conectar.</p><p>${String(e.message).replace(/[<>]/g,'')}</p>`}
      return send(res,200,`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;background:#0b0d11;color:#fff;padding:40px;max-width:760px;margin:auto"><h1>🔥 Caça Promo ML</h1>${html}<p><a style="color:#ffe000;font-size:18px" href="/">Voltar ao painel</a></p></body>`,'text/html; charset=utf-8');
    }
    if(url.pathname.startsWith('/api/admin/')){
      if(!admin(req,res))return;
      if(url.pathname==='/api/admin/state'&&req.method==='GET')return json(res,200,pub());
      if(url.pathname==='/api/admin/oauth/start'&&req.method==='POST'){if(!oauthReady())return json(res,400,{error:'Faltam ML_CLIENT_ID ou ML_CLIENT_SECRET nas variáveis do Render.'});const value=crypto.randomBytes(24).toString('hex');state.oauth_state={value,expires_at:Date.now()+10*60*1000};save();const u=new URL('https://auth.mercadolivre.com.br/authorization');u.searchParams.set('response_type','code');u.searchParams.set('client_id',ML_CLIENT_ID);u.searchParams.set('redirect_uri',ML_REDIRECT_URI);u.searchParams.set('state',value);return json(res,200,{authUrl:u.toString()})}
      if(url.pathname==='/api/admin/oauth/disconnect'&&req.method==='POST'){state.oauth=structuredClone(defaults.oauth);state.oauth_state=null;save();return json(res,200,{ok:true})}
      if(url.pathname==='/api/admin/scan'&&req.method==='POST')return json(res,200,await scan());
      if(url.pathname==='/api/admin/settings'&&req.method==='POST'){state.settings={...state.settings,...await body(req)};save();schedule();return json(res,200,state.settings)}
      if(url.pathname==='/api/admin/watchlists'&&req.method==='POST'){const b=await body(req),q=String(b.query||'').trim();if(!q)return json(res,400,{error:'Busca vazia.'});if(!state.watchlists.some(w=>w.query.toLowerCase()===q.toLowerCase()))state.watchlists.push({id:String(Date.now()),query:q,enabled:true});save();return json(res,200,state.watchlists)}
      let m=url.pathname.match(/^\/api\/admin\/watchlists\/([^/]+)$/);if(m&&req.method==='DELETE'){state.watchlists=state.watchlists.filter(w=>w.id!==decodeURIComponent(m[1]));save();return json(res,200,state.watchlists)}
      m=url.pathname.match(/^\/api\/admin\/queue\/([^/]+)$/);if(m&&req.method==='PATCH'){const id=decodeURIComponent(m[1]),p=state.queue.find(x=>x.id===id);if(!p)return json(res,404,{error:'Produto não encontrado.'});const b=await body(req);if('affiliate_url'in b)p.affiliate_url=String(b.affiliate_url||'').trim();if('status'in b)p.status=String(b.status||'pending');save();return json(res,200,p)}
      if(m&&req.method==='DELETE'){state.queue=state.queue.filter(x=>x.id!==decodeURIComponent(m[1]));save();return json(res,200,{ok:true})}
      return json(res,404,{error:'Rota não encontrada.'});
    }
    return staticFile(url,res);
  }catch(e){console.log('[HTTP ERROR]',e.message);json(res,500,{error:'Erro interno.',details:e.message})}
});
server.listen(PORT,HOST,()=>{console.log(`Caça Promo ML: http://localhost:${PORT}`);console.log(`OAuth Mercado Livre: ${oauthReady()?'configurado':'faltando credenciais'}`);console.log('Busca: catálogo + produtos filhos + Buy Box');if(state.settings.autoScan&&connected())scan().catch(e=>console.log('[START SCAN]',e.message))});
