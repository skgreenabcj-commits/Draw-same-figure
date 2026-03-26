/**
 * gemini.js  v5.11.0
 * 変更点 (v5.10.0 → v5.11.0):
 *   FIX-H1: _normalize で hintLines を正しく付与。
 *            LEVEL_CFG[level].hints 本数だけ lines の先頭から切り出す。
 *            旧: prob.hintLines = prob.hintLines || []  ← 常に空配列
 *            新: LEVEL_CFG を参照して hintCount 本をスライス
 *   FIX-C1: _isCollinearOverlap を新設。
 *            同一直線上にあり共有点・共有区間を持つ2線分を検出する。
 *            （端点のみ共有でも同一直線上なら幼児が視覚的に識別困難）
 *   FIX-C2: _hasCollision を新設。問題内の全線分ペアを _isCollinearOverlap で検査。
 *   FIX-C3: _validate にコリジョン除外を追加。
 *            _hasCollision が true の問題は不正問題として除外する。
 */

/* ============================================================
   §0. 定数  ※変更なし
   ============================================================ */
const API_BASE_URL   = 'https://generativelanguage.googleapis.com';
const MODEL_LIST_URL = `${API_BASE_URL}/v1beta/models`;
const GEN_URL_TPL    = (m) => `${API_BASE_URL}/v1beta/models/${m}:generateContent`;

const MODEL_CACHE_KEY  = 'gemini_model_v3';
const ADMIN_CHAIN_KEY  = 'gemini_admin_chain_v1';
const ADMIN_STATUS_KEY = 'gemini_admin_status_v1';
const ALERT_LOG_KEY    = 'gemini_alert_log_v1';
const API_KEY_STORAGE  = 'gemini_api_key';

const MODEL_CACHE_TTL   = 60 * 60 * 1000;
const ALERT_LOG_MAX     = 100;
const TARGET_COUNT      = 5;
const LEVEL_ALERT_RATIO = 0.61;

const EXCLUDED_KEYWORDS  = ['pro', 'image'];
const PREFERRED_KEYWORDS = ['flash-lite', 'flash'];

const FALLBACK_CHAIN = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
];

const LEVEL_CFG = [
  { lines: 3, hints: 2, intersections: [0, 3] },  // Lv0
  { lines: 4, hints: 2, intersections: [0, 5] },  // Lv1
  { lines: 4, hints: 0, intersections: [2, 5] },  // Lv2
  { lines: 5, hints: 0, intersections: [0, 8] }   // Lv3
];

/* ============================================================
   §1. アラートログ  ※変更なし
   ============================================================ */
function getAlertLogKey() { return ALERT_LOG_KEY; }

function _appendAlertLog(entry) {
  try {
    const raw  = localStorage.getItem(ALERT_LOG_KEY);
    const logs = raw ? JSON.parse(raw) : [];
    logs.unshift({
      ts        : new Date().toISOString(),
      alertType : entry.alertType || 'UNKNOWN',
      message   : entry.message   || '',
      model     : entry.model     || '',
      rawJson   : entry.rawJson   || ''
    });
    if (logs.length > ALERT_LOG_MAX) logs.length = ALERT_LOG_MAX;
    localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(logs));
  } catch (e) {
    console.warn('[gemini] _appendAlertLog error:', e);
  }
}

/* ============================================================
   §2. ステータス管理  ※変更なし
   ============================================================ */
let _status = {
  errorCount       : 0,
  lastSuccessModel : null,
  lastSuccessTs    : null,
  lastError        : null,
  lastErrorTs      : null,
  needsUpdate      : false,
  alertType        : null
};

function _updateStatus(patch) {
  _status = Object.assign({}, _status, { alertType: null }, patch);
  try {
    const stored = JSON.parse(localStorage.getItem(ADMIN_STATUS_KEY) || '{}');
    const merged = Object.assign({}, stored, { alertType: null }, patch, {
      _ts: new Date().toISOString()
    });
    localStorage.setItem(ADMIN_STATUS_KEY, JSON.stringify(merged));
  } catch (e) {
    console.warn('[gemini] _updateStatus localStorage error:', e);
  }
  try {
    window.dispatchEvent(new CustomEvent('geminiStatusUpdate', { detail: _status }));
  } catch (_) {}
}

function _saveModel(model) {
  _updateStatus({
    lastSuccessModel : model,
    lastSuccessTs    : new Date().toISOString(),
    needsUpdate      : false,
    alertType        : null
  });
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ model, ts: Date.now() }));
  } catch (_) {}
}

/* ============================================================
   §3. API キー  ※変更なし
   ============================================================ */
function saveApiKey(key) {
  try { localStorage.setItem(API_KEY_STORAGE, key); } catch (_) {}
}
function loadApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch (_) { return ''; }
}
function clearApiKey() {
  try { localStorage.removeItem(API_KEY_STORAGE); } catch (_) {}
}

/* ============================================================
   §4. モデルキャッシュ  ※変更なし
   ============================================================ */
function clearModelCache() {
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch (_) {}
}

function _loadCachedModel() {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if (!raw) return null;
    const { model, ts } = JSON.parse(raw);
    if (Date.now() - ts > MODEL_CACHE_TTL) return null;
    return model || null;
  } catch (_) { return null; }
}

/* ============================================================
   §5. 管理者チェーン  ※変更なし
   ============================================================ */
function saveAdminChain(chain) {
  if (!Array.isArray(chain)) {
    console.warn('[gemini] saveAdminChain: chain is not an array, aborting save');
    return;
  }
  try { localStorage.setItem(ADMIN_CHAIN_KEY, JSON.stringify(chain)); } catch (_) {}
}

function loadAdminChain() {
  try {
    const raw = localStorage.getItem(ADMIN_CHAIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn('[gemini] loadAdminChain: stored value is not a valid array, clearing');
      localStorage.removeItem(ADMIN_CHAIN_KEY);
      return null;
    }
    const validChain = parsed.filter(item => typeof item === 'string' && item.trim() !== '');
    if (validChain.length === 0) {
      localStorage.removeItem(ADMIN_CHAIN_KEY);
      return null;
    }
    return validChain;
  } catch (_) {
    localStorage.removeItem(ADMIN_CHAIN_KEY);
    return null;
  }
}

function clearAdminChain() {
  try { localStorage.removeItem(ADMIN_CHAIN_KEY); } catch (_) {}
}

/* ============================================================
   §6. ライブモデル取得  ※変更なし
   ============================================================ */
async function fetchLiveModels(apiKey) {
  const key = apiKey || loadApiKey();
  if (!key) throw new Error('API key is not set');

  const res = await fetch(`${MODEL_LIST_URL}?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Model list fetch failed: ${res.status}`);

  const data = await res.json();
  const all  = (data.models || []).map(m => m.name.replace('models/', ''));

  const filtered = all.filter(name =>
    !EXCLUDED_KEYWORDS.some(kw => name.toLowerCase().includes(kw))
  );
  const preferred = filtered.filter(name =>
    PREFERRED_KEYWORDS.some(kw => name.toLowerCase().includes(kw))
  );
  const rest = filtered.filter(name =>
    !PREFERRED_KEYWORDS.some(kw => name.toLowerCase().includes(kw))
  );
  return [...preferred, ...rest];
}

/* ============================================================
   §7. 有効チェーン構築  ※変更なし
   ============================================================ */
function _buildEffectiveChain() {
  const admin = loadAdminChain();
  if (Array.isArray(admin) && admin.length > 0) return admin;
  return FALLBACK_CHAIN;
}

/* ============================================================
   §8. プロンプト生成  ※変更なし
   ============================================================ */
function _makePrompt(level) {
  const cfg      = LEVEL_CFG[level] || LEVEL_CFG[0];
  const gridSize = (level === 3) ? 5 : 4;
  const maxCoord = gridSize - 1;
  return `
You are a puzzle generator. Generate exactly ${TARGET_COUNT} unique line-crossing puzzles.
Rules:
- Grid: ${gridSize}×${gridSize} dots (coordinates 0–${maxCoord} on both axes)
- Each puzzle has exactly ${cfg.lines} line segments
- Each line segment: {x1,y1,x2,y2} where all values are integers 0–${maxCoord}
- No duplicate lines within a puzzle
- Each puzzle must have between ${cfg.intersections[0]} and ${cfg.intersections[1]} proper intersections (interior crossing only, shared endpoints do NOT count)
- Output ONLY a valid JSON array, no markdown, no explanation

Format:
[{"lines":[{"x1":0,"y1":0,"x2":${maxCoord},"y2":${maxCoord}},...]},...]
`.trim();
}

/* ============================================================
   §9. JSON 抽出  ※変更なし
   ============================================================ */
function _extractJson(text) {
  if (!text) return null;
  const m = text.match(/\[[\s\S]*\]/);
  return m ? m[0] : null;
}

/* ============================================================
   §10. 交差判定  ※変更なし
   ============================================================ */
function _cross(a, b) {
  const dx1 = a.x2 - a.x1, dy1 = a.y2 - a.y1;
  const dx2 = b.x2 - b.x1, dy2 = b.y2 - b.y1;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (denom === 0) return false;
  const dx3 = b.x1 - a.x1, dy3 = b.y1 - a.y1;
  const t = (dx3 * dy2 - dy3 * dx2) / denom;
  const u = (dx3 * dy1 - dy3 * dx1) / denom;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

function _countCross(lines) {
  let count = 0;
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      if (_cross(lines[i], lines[j])) count++;
  return count;
}

/* ============================================================
   §10b. コリジョン判定  ★ FIX-C1 新設
   同一直線上にあり、共有点または共有区間を持つ2線分を検出する。
   幼児が視覚的に識別困難な「重なり線」を除外するための処理。

   判定手順:
     1. 外積で平行（同一直線候補）かチェック
     2. b の端点が a の直線上にあるか内積でチェック（共線確認）
     3. 1D での区間重複チェック（x または y 軸方向の投影）
   ============================================================ */
function _isCollinearOverlap(a, b) {
  const dax = a.x2 - a.x1, day = a.y2 - a.y1;
  const dbx = b.x2 - b.x1, dby = b.y2 - b.y1;

  // ① 外積 = 0 なら平行（または同一直線候補）
  const cross = dax * dby - day * dbx;
  if (cross !== 0) return false;

  // ② b の始点が a の直線上にあるか（外積で確認）
  const dcx = b.x1 - a.x1, dcy = b.y1 - a.y1;
  if (dax * dcy - day * dcx !== 0) return false;
  // ここまでで 2線分は同一直線上にある

  // ③ 1D 区間重複チェック
  // x 方向が有効なら x で、垂直線なら y で判定
  if (dax !== 0) {
    const aMin = Math.min(a.x1, a.x2), aMax = Math.max(a.x1, a.x2);
    const bMin = Math.min(b.x1, b.x2), bMax = Math.max(b.x1, b.x2);
    return aMin <= bMax && bMin <= aMax; // 区間が重複または接触
  } else {
    const aMin = Math.min(a.y1, a.y2), aMax = Math.max(a.y1, a.y2);
    const bMin = Math.min(b.y1, b.y2), bMax = Math.max(b.y1, b.y2);
    return aMin <= bMax && bMin <= aMax;
  }
}

/* ============================================================
   FIX-C2: 問題内にコリジョンペアが1つでもあれば true
   ============================================================ */
function _hasCollision(lines) {
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      if (_isCollinearOverlap(lines[i], lines[j])) return true;
  return false;
}

/* ============================================================
   §11. バリデーション  ★ FIX-C3 コリジョン除外を追加
   ============================================================ */
function _validate(prob, level) {
  const cfg = LEVEL_CFG[level] || LEVEL_CFG[0];
  if (!prob || !Array.isArray(prob.lines)) return false;
  if (prob.lines.length !== cfg.lines) return false;

  // FIX-C3: コリジョン（同一直線上の重なり）がある問題は除外
  if (_hasCollision(prob.lines)) return false;

  const cross = _countCross(prob.lines);
  return cross >= cfg.intersections[0] && cross <= cfg.intersections[1];
}

/* ============================================================
   §12. 正規化  ★ FIX-H1: hintLines を正しく付与
   ============================================================ */
function _normalize(prob, level) {
  if (!prob || !Array.isArray(prob.lines)) return prob;

  // lines を数値に正規化
  prob.lines = prob.lines.map(l => ({
    x1: Number(l.x1), y1: Number(l.y1),
    x2: Number(l.x2), y2: Number(l.y2)
  }));

  const gridSize = (level === 3) ? 5 : 4;
  prob.grid  = prob.grid  || { cols: gridSize, rows: gridSize };
  prob.level = prob.level ?? level;

  /* ★ FIX-H1: LEVEL_CFG の hints 本数を参照して hintLines を生成する。
     Gemini 応答には hintLines が含まれないため、
     旧コードの「prob.hintLines || []」では常に空配列になっていた。
     修正後: hints 本数だけ lines 先頭からスライスして付与する。
     problems.js の getProblems() と同じロジックで統一する。 */
  const hintCount  = LEVEL_CFG[level]?.hints ?? 0;
  prob.hintLines   = (prob.hintLines && prob.hintLines.length > 0)
                       ? prob.hintLines               // 既に有効なヒントがあれば保持
                       : prob.lines.slice(0, hintCount); // なければ先頭 N 本を付与

  return prob;
}

/* ============================================================
   §13. フォールバック問題バンク  ※変更なし
   ============================================================ */
const _FALLBACK_BANK = [
  { lines: [{ x1:0,y1:0,x2:3,y2:3 },{ x1:0,y1:3,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:1 }] },
  { lines: [{ x1:0,y1:0,x2:0,y2:3 },{ x1:0,y1:0,x2:3,y2:0 },{ x1:1,y1:1,x2:3,y2:3 }] },
  { lines: [{ x1:0,y1:1,x2:3,y2:1 },{ x1:1,y1:0,x2:1,y2:3 },{ x1:0,y1:0,x2:2,y2:2 }] },
  { lines: [{ x1:0,y1:0,x2:3,y2:0 },{ x1:0,y1:2,x2:3,y2:2 },{ x1:1,y1:0,x2:1,y2:3 }] },
  { lines: [{ x1:0,y1:0,x2:3,y2:3 },{ x1:0,y1:3,x2:3,y2:0 },{ x1:0,y1:2,x2:1,y2:2 }] }
];

/* ============================================================
   §14. API リクエスト  ※変更なし
   ============================================================ */
async function _callApi(model, prompt, apiKey) {
  const url  = `${GEN_URL_TPL(model)}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents        : [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
  };

  const res = await fetch(url, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(body)
  });

  if (res.status === 429) throw Object.assign(new Error('Rate limit'), { code: 429 });
  if (!res.ok)            throw new Error(`API error: ${res.status}`);

  const data    = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonStr = _extractJson(rawText);
  const parseOk = jsonStr !== null;

  return { rawText, jsonStr, parseOk };
}

/* ============================================================
   §15. メイン: generateProblems  ※変更なし
   ============================================================ */
async function generateProblems(level = 0) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    return {
      problems  : (typeof getProblems === 'function')
                    ? getProblems(level)
                    : _FALLBACK_BANK.slice(0, TARGET_COUNT),
      validCount: 0,
      alertType : null
    };
  }

  const chain  = _buildEffectiveChain();
  const prompt = _makePrompt(level);

  let collectedValid = [];
  let lastAlertType  = null;
  let lastRawJson    = '';
  let lastModel      = '';

  for (const model of chain) {
    lastModel     = model;
    lastAlertType = null;
    try {
      const { rawText, jsonStr, parseOk } = await _callApi(model, prompt, apiKey);
      lastRawJson = rawText;

      if (!parseOk) {
        lastAlertType = 'MODEL';
        _updateStatus({ errorCount: (_status.errorCount ?? 0) + 1, lastError: 'JSON parse failed', lastErrorTs: new Date().toISOString(), alertType: 'MODEL' });
        _appendAlertLog({ alertType: 'MODEL', message: 'JSON parse failed', model, rawJson: rawText });
        continue;
      }

      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch (_) {
        lastAlertType = 'MODEL';
        _updateStatus({ errorCount: (_status.errorCount ?? 0) + 1, lastError: 'JSON.parse threw', lastErrorTs: new Date().toISOString(), alertType: 'MODEL' });
        _appendAlertLog({ alertType: 'MODEL', message: 'JSON.parse threw', model, rawJson: jsonStr });
        continue;
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        lastAlertType = 'PROMPT';
        _updateStatus({ errorCount: (_status.errorCount ?? 0) + 1, lastError: 'Empty array', lastErrorTs: new Date().toISOString(), alertType: 'PROMPT' });
        _appendAlertLog({ alertType: 'PROMPT', message: 'Empty array from model', model, rawJson: jsonStr });
        continue;
      }

      const valid = parsed.map(p => _normalize(p, level)).filter(p => _validate(p, level));

      if (valid.length === 0) {
        lastAlertType = 'PROMPT';
        _updateStatus({ errorCount: (_status.errorCount ?? 0) + 1, lastError: 'No valid problems', lastErrorTs: new Date().toISOString(), alertType: 'PROMPT' });
        _appendAlertLog({ alertType: 'PROMPT', message: 'No valid problems in output', model, rawJson: jsonStr });
        continue;
      }

      collectedValid = collectedValid.concat(valid);
      _saveModel(model);
      if (collectedValid.length >= TARGET_COUNT) break;

    } catch (err) {
      lastAlertType = 'MODEL';
      _updateStatus({ errorCount: (_status.errorCount ?? 0) + 1, lastError: err.message, lastErrorTs: new Date().toISOString(), alertType: 'MODEL' });
      _appendAlertLog({ alertType: 'MODEL', message: err.message, model, rawJson: lastRawJson });
    }
  }

  const validCount = collectedValid.length;

  if (validCount === 0) {
    return {
      problems  : (typeof getProblems === 'function')
                    ? getProblems(level)
                    : _FALLBACK_BANK.slice(0, TARGET_COUNT),
      validCount: 0,
      alertType : lastAlertType
    };
  }

  const ratio = validCount / TARGET_COUNT;
  if (ratio < LEVEL_ALERT_RATIO) {
    const alertType = 'LEVEL';
    _updateStatus({ alertType });
    _appendAlertLog({
      alertType,
      message : `Only ${validCount}/${TARGET_COUNT} valid problems (${Math.round(ratio * 100)}%)`,
      model   : lastModel,
      rawJson : lastRawJson
    });
    const result = collectedValid.slice(0, TARGET_COUNT);
    if (result.length < TARGET_COUNT) {
      const localPool = (typeof getProblems === 'function')
        ? getProblems(level)
        : _FALLBACK_BANK.slice(0, TARGET_COUNT);
      let i = 0;
      while (result.length < TARGET_COUNT) {
        result.push(localPool[i % localPool.length]);
        i++;
      }
    }
    return { problems: result, validCount, alertType };
  }

  _updateStatus({ alertType: null });
  return { problems: collectedValid.slice(0, TARGET_COUNT), validCount, alertType: null };
}

/* ============================================================
   §16. エクスポート  ※変更なし
   ============================================================ */
window.GeminiAPI = {
  generateProblems,
  saveApiKey,
  loadApiKey,
  clearApiKey,
  fetchLiveModels,
  saveAdminChain,
  loadAdminChain,
  clearAdminChain,
  clearModelCache,
  getAlertLogKey
};
