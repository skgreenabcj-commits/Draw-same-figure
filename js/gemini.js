'use strict';

/* =====================================================================
   gemini.js  v3.0
   - Dynamic model selection with parallel probing & 24h cache
   - Intersection validation mirrors problems.js _cross exactly
   - Self-contained: no external dependencies
   - Level constraints:
       Lv0: 0-2  (4 lines, 4x4 grid)
       Lv1: 0-3  (4 lines, 4x4 grid)
       Lv2: 2-5  (4 lines, 4x4 grid)
       Lv3: 0-8  (5 lines, 5x5 grid)
===================================================================== */

const _G = (() => {

/* ── constants ─────────────────────────────────────────────────────── */
const BASE_URL        = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CACHE_KEY = 'gemini_model_v3';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

const PREFERRED_MODEL  = 'gemini-2.5-flash';
const FALLBACK_MODELS  = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.0-pro'
];

const LEVEL_CFG = {
  0: { lines:4, gridN:3, lo:0, hi:2, hints:3 },
  1: { lines:4, gridN:3, lo:0, hi:3, hints:2 },
  2: { lines:4, gridN:3, lo:2, hi:5, hints:0 },
  3: { lines:5, gridN:4, lo:0, hi:8, hints:0 }
};

/* ── strict internal intersection (identical to problems.js _cross) ── */
function _cross(ax,ay,bx,by,cx,cy,dx,dy){
  if((ax===cx&&ay===cy)||(ax===dx&&ay===dy)) return false;
  if((bx===cx&&by===cy)||(bx===dx&&by===dy)) return false;
  const d1=(dx-cx)*(ay-cy)-(dy-cy)*(ax-cx);
  const d2=(dx-cx)*(by-cy)-(dy-cy)*(bx-cx);
  const d3=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
  const d4=(bx-ax)*(dy-ay)-(by-ay)*(dx-ax);
  return ((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0));
}
function _countCross(lines){
  let n=0;
  for(let i=0;i<lines.length;i++)
    for(let j=i+1;j<lines.length;j++)
      if(_cross(lines[i].x1,lines[i].y1,lines[i].x2,lines[i].y2,
                lines[j].x1,lines[j].y1,lines[j].x2,lines[j].y2)) n++;
  return n;
}
function _validate(lines, level){
  const {lo,hi} = LEVEL_CFG[level] || LEVEL_CFG[1];
  const n = _countCross(lines);
  return n >= lo && n <= hi;
}

/* ── normalise raw AI output into canonical line objects ────────────── */
function _normalise(raw, level){
  const cfg  = LEVEL_CFG[level] || LEVEL_CFG[1];
  const maxC = cfg.gridN;
  const clamp = v => Math.max(0, Math.min(maxC, Math.round(Number(v)||0)));

  const lines = (raw.lines||[])
    .map(l => ({
      x1: clamp(l.x1 ?? l.x ?? 0),
      y1: clamp(l.y1 ?? l.y ?? 0),
      x2: clamp(l.x2 ?? (l.x+1) ?? 1),
      y2: clamp(l.y2 ?? (l.y+1) ?? 1)
    }))
    .filter(l => !(l.x1===l.x2 && l.y1===l.y2)); // drop zero-length

  if(lines.length !== cfg.lines) return null;

  // build hintLines indices (first cfg.hints lines)
  const hintLines = Array.from({length: cfg.hints}, (_,i) => i);

  return {
    level,
    grid: { cols: cfg.gridN+1, rows: cfg.gridN+1 },
    lines,
    hintLines
  };
}

/* ── model cache ────────────────────────────────────────────────────── */
function _loadCachedModel(){
  try{
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if(!raw) return null;
    const {model, ts} = JSON.parse(raw);
    if(Date.now()-ts < MODEL_CACHE_TTL) return model;
  }catch(_){}
  return null;
}
function _saveModel(model){
  try{ localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({model, ts:Date.now()})); }catch(_){}
}
function clearModelCache(){
  try{ localStorage.removeItem(MODEL_CACHE_KEY); }catch(_){}
}

/* ── probe a single model (5 s timeout) ────────────────────────────── */
async function _probeModel(model, apiKey){
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 5000);
  try{
    const r = await fetch(
      `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method : 'POST',
        headers: {'Content-Type':'application/json'},
        signal : ctrl.signal,
        body   : JSON.stringify({
          contents:[{parts:[{text:'Reply with the single word: ready'}]}],
          generationConfig:{maxOutputTokens:10}
        })
      }
    );
    clearTimeout(tid);
    return r.ok;
  }catch(e){
    clearTimeout(tid);
    return false;
  }
}

/* ── fetch available models from API ───────────────────────────────── */
async function _fetchAvailableModels(apiKey){
  try{
    const r = await fetch(`${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`);
    if(!r.ok) return null;
    const data = await r.json();
    return (data.models||[])
      .filter(m => (m.supportedGenerationMethods||[]).includes('generateContent'))
      .map(m => m.name.replace('models/',''));
  }catch(_){ return null; }
}

/* ── resolve best available model (preferred → fallback list) ───────── */
async function resolveModel(apiKey){
  const cached = _loadCachedModel();
  if(cached){ console.log(`[gemini] Using cached model: ${cached}`); return cached; }

  // Try preferred model first
  console.log(`[gemini] Probing preferred model: ${PREFERRED_MODEL}`);
  if(await _probeModel(PREFERRED_MODEL, apiKey)){
    console.log(`[gemini] Selected preferred: ${PREFERRED_MODEL}`);
    _saveModel(PREFERRED_MODEL);
    return PREFERRED_MODEL;
  }

  // Fetch available models from API
  const available = await _fetchAvailableModels(apiKey);
  let candidates = FALLBACK_MODELS.slice();
  if(available){
    // Prioritise models that appear in the API list
    const apiSet = new Set(available);
    const known  = candidates.filter(m => apiSet.has(m));
    const extra  = available.filter(m => !candidates.includes(m) && m.startsWith('gemini'));
    candidates   = [...known, ...extra];
    console.log(`[gemini] API candidates: ${candidates.slice(0,5).join(', ')}…`);
  }

  // Probe top-3 in parallel, then remainder serially
  const top3    = candidates.slice(0,3);
  const rest    = candidates.slice(3);

  const top3Ok = await Promise.all(top3.map(m => _probeModel(m, apiKey)));
  for(let i=0;i<top3.length;i++){
    if(top3Ok[i]){
      console.log(`[gemini] Selected (parallel probe): ${top3[i]}`);
      _saveModel(top3[i]);
      return top3[i];
    }
  }
  for(const m of rest){
    if(await _probeModel(m, apiKey)){
      console.log(`[gemini] Selected (serial probe): ${m}`);
      _saveModel(m);
      return m;
    }
  }

  console.warn('[gemini] No reachable model found, defaulting to gemini-2.0-flash');
  return 'gemini-2.0-flash';
}

/* ── build generation prompt ────────────────────────────────────────── */
function _buildPrompt(level, count){
  const cfg   = LEVEL_CFG[level] || LEVEL_CFG[1];
  const {lines: lineCount, gridN, lo, hi} = cfg;
  const maxCoord = gridN;

  return `You are generating line puzzle problems for a visual math game.

Rules:
- Each problem has exactly ${lineCount} line segments on a ${maxCoord+1}x${maxCoord+1} grid.
- All coordinates are integers in the range [0, ${maxCoord}] (inclusive).
- No zero-length lines (x1==x2 AND y1==y2 is forbidden).
- The number of STRICT INTERNAL intersections must be between ${lo} and ${hi} (inclusive).
  - "Strict internal" means two segments cross at a point that is interior to BOTH segments.
  - Shared endpoints do NOT count as intersections.
  - A point touching only one segment's endpoint does NOT count.
- Generate exactly ${count} distinct problems.

Self-check before outputting:
1. For every pair of lines, determine if they strictly internally intersect.
2. Count the total intersections for the problem.
3. Confirm the count is in [${lo}, ${hi}].
4. If not, adjust the lines and recheck.

Output ONLY a JSON array, no markdown, no explanation:
[
  { "lines": [
      {"x1":0,"y1":0,"x2":2,"y2":3},
      ...${lineCount} lines total...
  ]},
  ...${count} problems total...
]`;
}

/* ── embedded fallback bank ─────────────────────────────────────────── */
const _FALLBACK = {
  0: [
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},{x1:0,y1:2,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:0,y2:3},{x1:1,y1:0,x2:1,y2:3},{x1:2,y1:0,x2:2,y2:3},{x1:3,y1:0,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:1},{x1:2,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:0},{x1:0,y1:2,x2:1,y2:3},{x1:1,y1:2,x2:0,y2:3}]}
  ],
  1: [
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},{x1:0,y1:2,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:1},{x1:2,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:1,y1:0,x2:0,y2:3},{x1:3,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:1},{x1:0,y1:0,x2:3,y2:3},{x1:2,y1:0,x2:3,y2:0}]}
  ],
  2: [
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:1,y1:0,x2:2,y2:3},{x1:0,y1:3,x2:1,y2:3}]},
    {lines:[{x1:0,y1:0,x2:2,y2:3},{x1:2,y1:0,x2:0,y2:3},{x1:1,y1:1,x2:3,y2:3},{x1:3,y1:0,x2:1,y2:2}]},
    {lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:2}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:0,y1:3,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:3}]}
  ],
  3: [
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},{x1:0,y1:2,x2:4,y2:2},{x1:2,y1:0,x2:2,y2:4},{x1:0,y1:1,x2:4,y2:3}]},
    {lines:[{x1:0,y1:0,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:0},{x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},{x1:0,y1:4,x2:4,y2:4}]},
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},{x1:0,y1:1,x2:4,y2:1},{x1:0,y1:3,x2:4,y2:3},{x1:2,y1:0,x2:2,y2:4}]},
    {lines:[{x1:0,y1:0,x2:3,y2:4},{x1:1,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:3,y2:0},{x1:1,y1:4,x2:4,y2:0},{x1:0,y1:2,x2:4,y2:2}]},
    {lines:[{x1:0,y1:1,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:1},{x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},{x1:0,y1:0,x2:4,y2:4}]}
  ]
};

function _getFallback(level, count){
  const pool = (
    typeof PROBLEM_BANK !== 'undefined' && PROBLEM_BANK[level]
      ? PROBLEM_BANK[level]
      : _FALLBACK[level] || _FALLBACK[1]
  ).slice();
  // shuffle
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }
  // attach hintLines if missing
  const cfg = LEVEL_CFG[level]||LEVEL_CFG[1];
  return pool.slice(0,count).map(p => ({
    level,
    grid: {cols: cfg.gridN+1, rows: cfg.gridN+1},
    lines: p.lines,
    hintLines: p.hintLines || Array.from({length:cfg.hints},(_,i)=>i)
  }));
}

/* ── main generation function ───────────────────────────────────────── */
async function generateProblems(level, count, apiKey){
  if(!apiKey){
    console.warn('[gemini] No API key – using fallback bank');
    return _getFallback(level, count);
  }

  let model;
  try{ model = await resolveModel(apiKey); }
  catch(e){
    console.error('[gemini] resolveModel failed:', e);
    return _getFallback(level, count);
  }

  const MAX_ATTEMPTS = 5;
  const collected    = [];

  for(let attempt=1; attempt<=MAX_ATTEMPTS && collected.length<count; attempt++){
    const need   = count - collected.length;
    const prompt = _buildPrompt(level, need);

    console.log(`[gemini] Attempt ${attempt}/${MAX_ATTEMPTS} model=${model} need=${need}`);

    let raw;
    try{
      const resp = await fetch(
        `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method : 'POST',
          headers: {'Content-Type':'application/json'},
          body   : JSON.stringify({
            contents:[{parts:[{text:prompt}]}],
            generationConfig:{
              temperature      : 0.7,
              maxOutputTokens  : 2048,
              responseMimeType : 'application/json'
            }
          })
        }
      );

      if(resp.status===429){
        console.warn('[gemini] Rate limited, waiting 3 s…');
        await new Promise(r=>setTimeout(r,3000));
        continue;
      }
      if(resp.status===403||resp.status===400){
        console.error(`[gemini] HTTP ${resp.status} – clearing cache`);
        clearModelCache();
        break;
      }
      if(!resp.ok){
        console.warn(`[gemini] HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Extract JSON array from response
      const match = text.match(/\[[\s\S]*\]/);
      if(!match){ console.warn('[gemini] No JSON array in response'); continue; }
      raw = JSON.parse(match[0]);
      if(!Array.isArray(raw)){ continue; }
    }catch(e){
      console.error('[gemini] Fetch/parse error:', e);
      continue;
    }

    // Validate each candidate
    for(const candidate of raw){
      if(collected.length >= count) break;
      const p = _normalise(candidate, level);
      if(!p){
        console.log('[gemini] Normalise failed (wrong line count or zero-length)');
        continue;
      }
      const n = _countCross(p.lines);
      const {lo,hi} = LEVEL_CFG[level]||LEVEL_CFG[1];
      if(n < lo || n > hi){
        console.log(`[gemini] Rejected: cross=${n}, need [${lo},${hi}]`);
        continue;
      }
      console.log(`[gemini] Accepted: cross=${n} ✓`);
      collected.push(p);
    }
  }

  if(collected.length < count){
    console.warn(`[gemini] Only ${collected.length}/${count} valid – padding with fallback`);
    const pad = _getFallback(level, count - collected.length);
    collected.push(...pad);
  }

  return collected.slice(0, count);
}

/* ── API key helpers ────────────────────────────────────────────────── */
function saveApiKey(key){
  try{ localStorage.setItem('gemini_api_key', key); }catch(_){}
  clearModelCache();
}
function loadApiKey(){
  try{ return localStorage.getItem('gemini_api_key') || ''; }catch(_){ return ''; }
}

/* ── public surface ─────────────────────────────────────────────────── */
return { generateProblems, resolveModel, saveApiKey, loadApiKey, clearModelCache };

})(); // end _G IIFE

/* Re-export at module level for callers expecting flat names */
const generateProblems = _G.generateProblems;
const resolveModel     = _G.resolveModel;
const saveApiKey       = _G.saveApiKey;
const loadApiKey       = _G.loadApiKey;
const clearModelCache  = _G.clearModelCache;
