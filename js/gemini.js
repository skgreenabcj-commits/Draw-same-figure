/**
 * gemini.js  v5.10.0
 * 変更点 (v5.9.3 → v5.10.0):
 *   BUG-B1: _normalize(prob, level) に level 引数を追加。
 *           grid / level / hintLines を付与するよう修正。
 *           → Gemini生成問題で problem.grid.cols undefined クラッシュを解消。
 *   BUG-B2: LEVEL_CFG の Lv2/Lv3 lines数を problems.js と一致させた。
 *           Lv2: lines:5→4, intersections:[2,8]→[2,5]
 *           Lv3: lines:6→5, intersections:[3,12]→[0,8]
 *   BUG-B3: _makePrompt がLv3でも4×4を指示していた問題を修正。
 *           gridSize / maxCoord をレベルに応じて動的に決定。
 */

/* ============================================================
   §0. 定数
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

/* ★ BUG-B2修正: problems.js の仕様に合わせて lines数・intersections を修正
   Lv0: 3本, 4×4, 交差0-3
   Lv1: 4本, 4×4, 交差0-5
   Lv2: 4本, 4×4, 交差2-5  (旧: lines:5, intersections:[2,8])
   Lv3: 5本, 5×5, 交差0-8  (旧: lines:6, intersections:[3,12]) */
const LEVEL_CFG = [
  { lines: 3, hints: 2, intersections: [0, 3]  },  // Lv0
  { lines: 4, hints: 2, intersections: [0, 5]  },  // Lv1
  { lines: 4, hints: 0, intersections: [2, 5]  },  // Lv2 ★修正
  { lines: 5, hints: 0, intersections: [0, 8]  }   // Lv3 ★修正
];

/* ============================================================
   §1. アラートログ
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
   §2. ステータス管理
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
   §3. API キー
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
   §4. モデルキャッシュ
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
   §5. 管理者チェーン
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
   §6. ライブモデル取得
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
   §7. 有効チェーン構築
   ============================================================ */
function _buildEffectiveChain() {
  const admin = loadAdminChain();
  if (Array.isArray(admin) && admin.length > 0) return admin;
  return FALLBACK_CHAIN;
}

/* ============================================================
   §8. プロンプト生成  ★ BUG-B3修正
   Lv3は5×5グリッド（座標0–4）を正しく指示する
   ============================================================ */
function _makePrompt(level) {
  const cfg      = LEVEL_CFG[level] || LEVEL_CFG[0];
  /* ★ BUG-B3修正: Lv3のみ5×5グリッド、それ以外は4×4 */
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
   §9. JSON 抽出
   ============================================================ */
function _extractJson(text) {
  if (!text) return null;
  const m = text.match(/\[[\s\S]*\]/);
  return m ? m[0] : null;
}

/* ============================================================
   §10. 交差判定
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
   §11. バリデーション
   ============================================================ */
function _validate(prob, level) {
  const cfg = LEVEL_CFG[level] || LEVEL_CFG[0];
  if (!prob || !Array.isArray(prob.lines)) return false;
  if (prob.lines.length !== cfg.lines) return false;
  const cross = _countCross(prob.lines);
  return cross >= cfg.intersections[0] && cross <= cfg.intersections[1];
}

/* ============================================================
   §12. 正規化  ★ BUG-B1修正
   level 引数を追加し、grid / level / hintLines を付与する
   ============================================================ */
function _normalize(prob, level) {
  if (!prob || !Array.isArray(prob.lines)) return prob;

  /* lines を数値に正規化 */
  prob.lines = prob.lines.map(l => ({
    x1: Number(l.x1), y1: Number(l.y1),
    x2: Number(l.x2), y2: Number(l.y2)
  }));

  /* ★ BUG-B1修正: canvas.js が必要とするフィールドを付与
     Gemini応答には grid / level / hintLines が含まれないため補完する */
  const gridSize   = (level === 3) ? 5 : 4;
  prob.grid      = prob.grid      || { cols: gridSize, rows: gridSize };
  prob.level     = prob.level     ?? level;
  prob.hintLines = prob.hintLines || [];

  return prob;
}

/* ============================================================
   §13. フォールバック問題バンク
   ============================================================ */
const _FALLBACK_BANK = [
  { lines: [{ x1:0,y1:0,x2:3,y2:3 },{ x1:0,y1:3,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:1 }] },
  { lines: [{ x1:0,y1:0,x2:0,y2:3 },{ x1:0,y1:0,x2:3,y2:0 },{ x1:1,y1:1,x2:3,y2:3 }] },
  { lines: [{ x1:0,y1:1,x2:3,y2:1 },{ x1:1,y1:0,x2:1,y2:3 },{ x1:0,y1:0,x2:2,y2:2 }] },
  { lines: [{ x1:0,y1:0,x2:3,y2:0 },{ x1:0,y1:2,x2:3,y2:2 },{ x1:1,y1:0,x2:1,y2:3 }] },
  { lines: [{ x1:0,y1:0,x2:3,y2:3 },{ x1:0,y1:3,x2:3,y2:0 },{ x1:0,y1:2,x2:1,y2:2 }] }
];

/* ============================================================
   §14. API リクエスト
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
   §15. メイン: generateProblems
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

      /* ★ BUG-B1修正: _normalize に level を渡す */
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

  /* ── 全モデル失敗 ── */
  if (validCount === 0) {
    return {
      problems  : (typeof getProblems === 'function')
                    ? getProblems(level)
                    : _FALLBACK_BANK.slice(0, TARGET_COUNT),
      validCount: 0,
      alertType : lastAlertType
    };
  }

  /* ── 問題数不足：ローカル問題で補完 ── */
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
   §16. エクスポート
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
