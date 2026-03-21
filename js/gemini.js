'use strict';

/* =====================================================================
   gemini.js  v5.7
   -----------------------------------------------------------------------
   v5.7 からの変更点（v5.6 → v5.7）:
     【Fix-H】_fetchLiveModels に image 系モデル除外を追加
       - EXCLUDED_KEYWORDS = ['pro', 'image'] に変更
       - admin.html 側のプルダウン連携に対応（FALLBACK_CHAIN 書き換えは
         saveAdminChain / loadAdminChain で既に対応済み）
   =====================================================================
*/

const _G = (() => {

/* §1. 定数 */
const BASE_URL               = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CACHE_KEY        = 'gemini_model_v3';
const MODEL_CACHE_TTL        = 24 * 60 * 60 * 1000;
const NO_MIME_CACHE_KEY      = 'gemini_no_mime_v1';
const NO_MIME_CACHE_TTL      = 7 * 24 * 60 * 60 * 1000;
const LIVE_MODELS_CACHE_KEY  = 'gemini_live_models_v1';
const LIVE_MODELS_CACHE_TTL  = 60 * 60 * 1000;
const ADMIN_CHAIN_KEY        = 'gemini_admin_chain_v1';

const FALLBACK_MODEL_CHAIN = [
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash'
];

// ── 【Fix-H】 image 系を追加 ──
const EXCLUDED_KEYWORDS  = ['pro', 'image'];
const PREFERRED_KEYWORDS = ['flash-lite', 'flash'];

const FETCH_TIMEOUT_MS       = 8000;
const MAX_429_PER_MODEL      = 2;
const MAX_ATTEMPTS_PER_MODEL = 2;
const ERROR_NOTIFY_THRESHOLD = 5;

const LEVEL_CFG = {
  0: { lines: 3, gridN: 3, lo: 0, hi: 6, hints: 2 },
  1: { lines: 4, gridN: 3, lo: 0, hi: 5, hints: 2 },
  2: { lines: 4, gridN: 3, lo: 2, hi: 5, hints: 0 },
  3: { lines: 5, gridN: 4, lo: 0, hi: 8, hints: 0 }
};

/* §2. 交差判定ヘルパー */
function _cross(ax,ay,bx,by,cx,cy,dx,dy){
  if((ax===cx&&ay===cy)||(ax===dx&&ay===dy))return false;
  if((bx===cx&&by===cy)||(bx===dx&&by===dy))return false;
  const d1=(dx-cx)*(ay-cy)-(dy-cy)*(ax-cx);
  const d2=(dx-cx)*(by-cy)-(dy-cy)*(bx-cx);
  const d3=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
  const d4=(bx-ax)*(dy-ay)-(by-ay)*(dx-ax);
  return(((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0)));
}
function _countCross(lines){
  let n=0;
  for(let i=0;i<lines.length;i++)
    for(let j=i+1;j<lines.length;j++)
      if(_cross(lines[i].x1,lines[i].y1,lines[i].x2,lines[i].y2,
                lines[j].x1,lines[j].y1,lines[j].x2,lines[j].y2))n++;
  return n;
}
function _isCollinearOverlap(a,b){
  const dxA=a.x2-a.x1,dyA=a.y2-a.y1;
  const c1=dxA*(b.y1-a.y1)-dyA*(b.x1-a.x1);
  const c2=dxA*(b.y2-a.y1)-dyA*(b.x2-a.x1);
  if(c1!==0||c2!==0)return false;
  const len2=dxA*dxA+dyA*dyA;
  if(len2===0)return false;
  const t1=(dxA*(b.x1-a.x1)+dyA*(b.y1-a.y1))/len2;
  const t2=(dxA*(b.x2-a.x1)+dyA*(b.y2-a.y1))/len2;
  return Math.max(t1,t2)>0&&Math.min(t1,t2)<1;
}
function _hasCollinearOverlap(lines){
  for(let i=0;i<lines.length;i++)
    for(let j=i+1;j<lines.length;j++)
      if(_isCollinearOverlap(lines[i],lines[j]))return true;
  return false;
}

/* §3. バリデーション */
function _validate(problem,cfg){
  return _countCross(problem.lines)>=cfg.lo&&_countCross(problem.lines)<=cfg.hi;
}

/* §4. 正規化 */
function _normalise(raw,level){
  const cfg=LEVEL_CFG[level]??LEVEL_CFG[1];
  const maxC=cfg.gridN;
  const clamp=v=>Math.max(0,Math.min(maxC,Math.round(Number(v)||0)));
  let lines=(raw.lines||[])
    .map(l=>({
      x1:clamp(l.x1??l.x??0),y1:clamp(l.y1??l.y??0),
      x2:clamp(l.x2??(l.x!==undefined?l.x+1:1)),
      y2:clamp(l.y2??(l.y!==undefined?l.y+1:1))
    }))
    .filter(l=>!(l.x1===l.x2&&l.y1===l.y2));
  const seen=new Set();
  lines=lines.filter(l=>{
    const key=(l.x1<l.x2||(l.x1===l.x2&&l.y1<=l.y2))
      ?`${l.x1},${l.y1},${l.x2},${l.y2}`:`${l.x2},${l.y2},${l.x1},${l.y1}`;
    if(seen.has(key)){console.warn(`[gemini] 重複除去`);return false;}
    seen.add(key);return true;
  });
  if(_hasCollinearOverlap(lines)){console.warn('[gemini] コリニア重複→棄却');return null;}
  if(lines.length!==cfg.lines)return null;
  return{level,grid:{cols:cfg.gridN+1,rows:cfg.gridN+1},lines,hintLines:lines.slice(0,cfg.hints)};
}

/* §5. JSONパーサー */
function _extractJsonArray(text){
  if(!text)return null;
  const s=text.replace(/```(?:json)?\s*([\s\S]*?)```/g,'$1').trim();
  for(const c of _extractAllArrayStrings(s).sort((a,b)=>b.length-a.length)){
    try{const p=JSON.parse(c);if(Array.isArray(p)&&p.length>0&&p.every(i=>i&&typeof i==='object'))return p;}catch(_){}
  }
  for(const c of _extractAllObjectStrings(s).sort((a,b)=>b.length-a.length)){
    try{const p=JSON.parse(c);if(p&&typeof p==='object'&&!Array.isArray(p)){
      for(const v of Object.values(p))if(Array.isArray(v)&&v.length>0&&v.every(i=>i&&typeof i==='object'))return v;
    }}catch(_){}
  }
  const objs=[];
  for(const line of s.split('\n')){const t=line.trim();if(t.startsWith('{')&&t.endsWith('}')){try{const o=JSON.parse(t);if(o&&'lines'in o)objs.push(o);}catch(_){}}}
  return objs.length>0?objs:null;
}
function _extractAllArrayStrings(text){const r=[];let d=0,s=-1;for(let i=0;i<text.length;i++){if(text[i]==='['){if(!d)s=i;d++;}else if(text[i]===']'){d--;if(!d&&s!==-1){r.push(text.slice(s,i+1));s=-1;}}}return r;}
function _extractAllObjectStrings(text){const r=[];let d=0,s=-1;for(let i=0;i<text.length;i++){if(text[i]==='{'){if(!d)s=i;d++;}else if(text[i]==='}'){d--;if(!d&&s!==-1){r.push(text.slice(s,i+1));s=-1;}}}return r;}

/* §6. no-mime キャッシュ */
function _isNoMimeCached(model){
  try{const raw=localStorage.getItem(NO_MIME_CACHE_KEY);if(!raw)return false;
    const cache=JSON.parse(raw);const e=cache[model];if(!e)return false;
    if(Date.now()-e.ts>=NO_MIME_CACHE_TTL){delete cache[model];localStorage.setItem(NO_MIME_CACHE_KEY,JSON.stringify(cache));return false;}
    return true;}catch(_){return false;}
}
function _setNoMimeCache(model){
  try{const raw=localStorage.getItem(NO_MIME_CACHE_KEY);const cache=raw?JSON.parse(raw):{};cache[model]={ts:Date.now()};localStorage.setItem(NO_MIME_CACHE_KEY,JSON.stringify(cache));}catch(_){}
}

/* §7. モデルキャッシュ・ライブ取得・チェーン構築 */
function _saveModel(model){try{localStorage.setItem(MODEL_CACHE_KEY,JSON.stringify({model,ts:Date.now()}));}catch(_){}}
function clearModelCache(){try{localStorage.removeItem(MODEL_CACHE_KEY);localStorage.removeItem(LIVE_MODELS_CACHE_KEY);}catch(_){}}
function saveAdminChain(chain){try{localStorage.setItem(ADMIN_CHAIN_KEY,JSON.stringify({chain,ts:Date.now()}));console.log(`[gemini] 管理者チェーン保存: ${chain.join(' → ')}`);}catch(_){}}
function loadAdminChain(){try{const raw=localStorage.getItem(ADMIN_CHAIN_KEY);if(!raw)return null;const{chain}=JSON.parse(raw);return Array.isArray(chain)&&chain.length>0?chain:null;}catch(_){return null;}}
function clearAdminChain(){try{localStorage.removeItem(ADMIN_CHAIN_KEY);}catch(_){}}

async function _fetchLiveModels(apiKey){
  try{
    const raw=localStorage.getItem(LIVE_MODELS_CACHE_KEY);
    if(raw){const{models,ts}=JSON.parse(raw);if(Date.now()-ts<LIVE_MODELS_CACHE_TTL){console.log(`[gemini] ライブモデルキャッシュ: ${models.length}件`);return models;}}
  }catch(_){}
  try{
    const ctrl=new AbortController();const tid=setTimeout(()=>ctrl.abort(),5000);
    const resp=await fetch(`${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`,{signal:ctrl.signal});
    clearTimeout(tid);
    if(!resp.ok){console.warn(`[gemini] /v1beta/models HTTP ${resp.status}`);return null;}
    const data=await resp.json();
    const models=(data.models||[])
      .filter(m=>{
        const name=m.name?.replace(/^models\//,'')||'';
        const supported=(m.supportedGenerationMethods||[]).includes('generateContent');
        const isFlash=name.includes('flash');
        // 【Fix-H】pro と image を両方除外
        const isExcluded=EXCLUDED_KEYWORDS.some(kw=>name.includes(kw));
        return supported&&isFlash&&!isExcluded;
      })
      .map(m=>m.name.replace(/^models\//,''));
    console.log(`[gemini] ライブflashモデル取得: ${models.length}件`,models);
    try{localStorage.setItem(LIVE_MODELS_CACHE_KEY,JSON.stringify({models,ts:Date.now()}));}catch(_){}
    return models;
  }catch(e){console.warn('[gemini] ライブモデル取得エラー:',e.message);return null;}
}

async function _buildEffectiveChain(apiKey){
  const liveModels=await _fetchLiveModels(apiKey);
  const adminChain=loadAdminChain();
  if(!liveModels){const chain=adminChain||FALLBACK_MODEL_CHAIN;return{chain,needsRedo:false,liveModels:null};}
  if(adminChain){
    const alive=adminChain.filter(m=>liveModels.includes(m));
    const dead=adminChain.filter(m=>!liveModels.includes(m));
    if(dead.length>0){console.warn(`[gemini] 廃止モデル: ${dead.join(', ')}`);return{chain:alive.length>0?alive:FALLBACK_MODEL_CHAIN,needsRedo:true,liveModels};}
    return{chain:adminChain,needsRedo:false,liveModels};
  }
  const alive=FALLBACK_MODEL_CHAIN.filter(m=>liveModels.includes(m));
  const inChain=new Set(FALLBACK_MODEL_CHAIN);
  const supplements=[];
  for(const kw of PREFERRED_KEYWORDS){for(const m of liveModels){if(m.includes(kw)&&!inChain.has(m)&&!supplements.includes(m)){supplements.push(m);break;}}}
  const chain=[...alive,...supplements];
  return{chain:chain.length>0?chain:FALLBACK_MODEL_CHAIN,needsRedo:false,liveModels};
}

/* §9. プロンプト生成 */
function _buildPrompt(level,count){
  const cfg=LEVEL_CFG[level]??LEVEL_CFG[1];
  const{lines:lineCount,gridN,lo,hi}=cfg;
  return`You are generating line puzzle problems for a visual math game for young children.

Rules:
- Each problem has exactly ${lineCount} line segments on a ${gridN+1}x${gridN+1} grid.
- All coordinates are integers in the range [0, ${gridN}] (inclusive).
- No zero-length lines (x1==x2 AND y1==y2 is forbidden).
- Each line segment must be VISUALLY DISTINCT. Two segments must NOT overlap in any way:
  (a) Identical endpoints (even reversed): forbidden.
  (b) Collinear overlap: if collinear AND share any common region, forbidden.
      FORBIDDEN: A:(0,0)-(3,3), B:(1,1)-(2,2) / A:(0,0)-(2,2), B:(1,1)-(3,3)
      ALLOWED:   A:(0,0)-(1,1), B:(2,2)-(3,3)
- STRICT INTERNAL intersections must be between ${lo} and ${hi} (inclusive).
- Generate exactly ${count} distinct problems.

Self-check each problem:
1a. No identical endpoints (including reversed).
1b. If collinear, confirm no shared region.
2. Count STRICT INTERNAL intersections → must be in [${lo}, ${hi}].
3. If any check fails, redesign and recheck.

Output ONLY a JSON array:
[{"lines":[{"x1":0,"y1":0,"x2":2,"y2":3},...${lineCount} lines]},... ${count} problems]`;
}

/* §10. フォールバック問題バンク */
const _FALLBACK={
  0:[
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},{x1:0,y1:2,x2:3,y2:2}]},
    {lines:[{x1:0,y1:0,x2:0,y2:3},{x1:1,y1:0,x2:1,y2:3},{x1:2,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1}]},
    {lines:[{x1:1,y1:0,x2:1,y2:3},{x1:2,y1:0,x2:2,y2:3},{x1:0,y1:1,x2:3,y2:1}]},
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:3,x2:3,y2:3},{x1:1,y1:0,x2:2,y2:3}]}
  ],
  1:[
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},{x1:0,y1:2,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:1},{x1:2,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:1,y1:0,x2:0,y2:3},{x1:3,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:1},{x1:0,y1:0,x2:3,y2:3},{x1:2,y1:0,x2:3,y2:0}]}
  ],
  2:[
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:1,y1:0,x2:2,y2:3},{x1:0,y1:3,x2:1,y2:3}]},
    {lines:[{x1:0,y1:0,x2:2,y2:3},{x1:2,y1:0,x2:0,y2:3},{x1:1,y1:1,x2:3,y2:3},{x1:3,y1:0,x2:1,y2:2}]},
    {lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:1}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:0,y1:3,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:3}]}
  ],
  3:[
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},{x1:0,y1:2,x2:4,y2:2},{x1:2,y1:0,x2:2,y2:4},{x1:0,y1:1,x2:4,y2:3}]},
    {lines:[{x1:0,y1:0,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:0},{x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},{x1:0,y1:4,x2:4,y2:4}]},
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},{x1:0,y1:1,x2:4,y2:1},{x1:0,y1:3,x2:4,y2:3},{x1:2,y1:0,x2:2,y2:4}]},
    {lines:[{x1:0,y1:0,x2:3,y2:4},{x1:1,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:3,y2:0},{x1:1,y1:4,x2:4,y2:0},{x1:0,y1:2,x2:4,y2:2}]},
    {lines:[{x1:0,y1:1,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:1},{x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},{x1:0,y1:0,x2:4,y2:4}]}
  ]
};
function _getFallback(level,count){
  const pool=(typeof PROBLEM_BANK!=='undefined'&&PROBLEM_BANK[level]?PROBLEM_BANK[level]:_FALLBACK[level]||_FALLBACK[1]).slice();
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  const cfg=LEVEL_CFG[level]??LEVEL_CFG[1];
  return pool.slice(0,count).map(p=>({level,grid:p.grid??{cols:cfg.gridN+1,rows:cfg.gridN+1},lines:p.lines,hintLines:p.hintLines||p.lines.slice(0,cfg.hints)}));
}

/* §11. API送信コア */
async function _callApi(model,apiKey,prompt,forcePlain=false){
  const generationConfig={temperature:0.7,maxOutputTokens:2048};
  const useJsonMode=!forcePlain&&!_isNoMimeCached(model);
  if(useJsonMode)generationConfig.responseMimeType='application/json';
  console.log(`[gemini] _callApi: ${model} / ${useJsonMode?'JSON':'TEXT'}モード`);
  const ctrl=new AbortController();const tid=setTimeout(()=>ctrl.abort(),FETCH_TIMEOUT_MS);
  let resp;
  try{
    resp=await fetch(`${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,
       body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig})});
    clearTimeout(tid);
  }catch(e){clearTimeout(tid);const isTimeout=e.name==='AbortError';console.warn(`[gemini] ${isTimeout?'タイムアウト':'ネットワークエラー'}: ${model}`);return{raw:null,status:isTimeout?408:0};}
  if(resp.status===400&&useJsonMode){_setNoMimeCache(model);return _callApi(model,apiKey,prompt,true);}
  if(resp.status===404||resp.status===410){console.warn(`[gemini] HTTP ${resp.status}: ${model} 廃止の可能性`);return{raw:null,status:resp.status};}
  if(!resp.ok){console.warn(`[gemini] HTTP ${resp.status}: ${model}`);return{raw:null,status:resp.status};}
  let data;try{data=await resp.json();}catch(e){return{raw:null,status:200};}
  const part=data?.candidates?.[0]?.content?.parts?.[0];
  const rawText=part?.text;
  const text=(typeof rawText==='string'&&rawText.trim().length>0)?rawText.trim():null;
  console.log('[gemini] part keys:',part?Object.keys(part):'no part');
  console.log('[gemini] text length:',text!==null?text.length:'null');
  let problems=null;
  if(useJsonMode){
    if(text!==null){try{const p=JSON.parse(text);problems=Array.isArray(p)&&p.length>0?p:_extractJsonArray(text);}catch(e){problems=_extractJsonArray(text);}}
    else{problems=_extractJsonArray(JSON.stringify(data));if(!problems||problems.length===0){_setNoMimeCache(model);return _callApi(model,apiKey,prompt,true);}}
  }else{problems=text!==null?_extractJsonArray(text):_extractJsonArray(JSON.stringify(data));}
  return{raw:problems,status:resp.status};
}

/* §12. レスポンス検証・正規化 */
function _processRaw(raw,level,need){
  if(!Array.isArray(raw)||raw.length===0)return[];
  const cfg=LEVEL_CFG[level]??LEVEL_CFG[1];
  const valid=[];
  for(const item of raw){
    if(!item||typeof item!=='object')continue;
    const problem=_normalise(item,level);if(!problem)continue;
    if(!_validate(problem,cfg)){console.warn('[gemini] 交差数制約違反→棄却');continue;}
    valid.push(problem);if(valid.length>=need)break;
  }
  return valid;
}

/* §13. メインAPI: generateProblems */
function _updateStatus(patch){
  try{
    if(!window._geminiStatus)window._geminiStatus={errorCount:0,needsAdminRedo:false};
    Object.assign(window._geminiStatus,patch);
    window.dispatchEvent(new CustomEvent('geminiStatusUpdate',{detail:window._geminiStatus}));
  }catch(_){}
}

async function generateProblems(level,count=5,apiKey){
  if(!apiKey){console.log('[gemini] APIキーなし→フォールバック');return _getFallback(level,count);}
  const{chain,needsRedo,liveModels}=await _buildEffectiveChain(apiKey);
  _updateStatus({currentChain:chain,liveModels:liveModels||[]});
  if(needsRedo)_updateStatus({needsAdminRedo:true,lastError:'設定済みモデルが廃止されました。モデル設定を更新してください。'});
  if(chain.length===0){const msg='AIモデルが全て利用不可です。管理者設定でモデルを更新してください。';_updateStatus({needsAdminRedo:true,lastError:msg});return _getFallback(level,count);}
  const prompt=_buildPrompt(level,count);
  let sessionErrors=0;
  for(const model of chain){
    let attempts=0,count429=0;
    console.log(`[gemini] モデル試行: ${model}`);
    while(attempts<MAX_ATTEMPTS_PER_MODEL){
      attempts++;
      const{raw,status}=await _callApi(model,apiKey,prompt);
      if(status===401||status===403){console.error('[gemini] 認証エラー');_updateStatus({lastError:'APIキーが無効です。APIキーを確認してください。'});return _getFallback(level,count);}
      if(status===408||status===0){sessionErrors++;_updateStatus({errorCount:(window._geminiStatus?.errorCount||0)+1,lastError:`タイムアウト (${model})`});break;}
      if(status===404||status===410){sessionErrors++;_updateStatus({errorCount:(window._geminiStatus?.errorCount||0)+1,needsAdminRedo:true,lastError:`モデル廃止検出 (${model})。管理者設定でモデルを更新してください。`});break;}
      if(status===429){count429++;sessionErrors++;_updateStatus({errorCount:(window._geminiStatus?.errorCount||0)+1,lastError:`レート制限 (${model})`});if(count429>=MAX_429_PER_MODEL)break;await new Promise(r=>setTimeout(r,1000*Math.pow(2,count429-1)));continue;}
      const valid=_processRaw(raw,level,count);
      if(valid.length>=count){_saveModel(model);console.log(`[gemini] ${model} 成功: ${valid.length}件`);return valid.slice(0,count);}
      sessionErrors++;_updateStatus({errorCount:(window._geminiStatus?.errorCount||0)+1,lastError:`有効問題不足 (${model}: ${valid.length}/${count})`});
    }
    if(sessionErrors>=ERROR_NOTIFY_THRESHOLD)_updateStatus({needsAdminRedo:true,lastError:`エラーが${sessionErrors}回発生しました。モデル設定の確認を推奨します。`});
  }
  console.warn('[gemini] 全モデル失敗→フォールバック');return _getFallback(level,count);
}

/* §14. APIキー管理 */
const API_KEY_STORAGE='gemini_api_key';
function saveApiKey(key){try{localStorage.setItem(API_KEY_STORAGE,key);}catch(_){}}
function loadApiKey(){try{return localStorage.getItem(API_KEY_STORAGE)||'';}catch(_){return '';}}

/* §15. エクスポート */
return{generateProblems,saveApiKey,loadApiKey,clearModelCache,
       saveAdminChain,loadAdminChain,clearAdminChain,
       fetchLiveModels:_fetchLiveModels};
})();

const generateProblems = _G.generateProblems;
const saveApiKey       = _G.saveApiKey;
const loadApiKey       = _G.loadApiKey;
const clearModelCache  = _G.clearModelCache;
const saveAdminChain   = _G.saveAdminChain;
const loadAdminChain   = _G.loadAdminChain;
const clearAdminChain  = _G.clearAdminChain;
const fetchLiveModels  = _G.fetchLiveModels;
