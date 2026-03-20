'use strict';

/* =====================================================================
   gemini.js  v5.4
   -----------------------------------------------------------------------
   v5.4 からの変更点（v5.3 → v5.4）:
     【Fix-E】_callApi の JSON パースロジックを全面改修
       - §11: text が undefined / 空文字の場合の NullParseError を解消
           ・part?.text が非空文字列のときのみ text として使用、
             それ以外は null 扱いにしてフォールバックフローへ
           ・JSON mode かつ text 存在 → JSON.parse 直接試行。
             パース結果が配列でない場合は _extractJsonArray へ委譲。
           ・JSON mode かつ text が null  →  レスポンス全体を
             JSON.stringify して _extractJsonArray を試みる。
             それでも空なら no-mime キャッシュを記録して
             テキストモードで即時再試行（null 返却→呼び出し元ループへ）。
           ・テキストモード → _extractJsonArray で抽出（従来通り）。
           ・デバッグ用に part のキー一覧と text 長をログ出力。

   v5.3 の変更点（維持）:
     【Fix-D】コリニア重複（同一直線上の部分重複）対策
       - §2 末尾: _isCollinearOverlap / _hasCollinearOverlap を追加
       - §4 _normalise: Step2 コリニア重複チェック追加（検出時 null 返却）
       - §9 _buildPrompt: 禁止ルールと具体例を明示

   v5.2 の変更点（維持）:
     【Fix-A】LEVEL_CFG gridN 修正（4×4グリッドに統一）
       Lv0,1,2: gridN=3 / Lv3: gridN=4
     【Fix-B】_normalise Step1 端点一致重複除去
     【Fix-C】_buildPrompt 重複禁止制約文追加

   v5.1 の変更点（維持）:
     不要定数・コメントのクリーンアップ

   v5.0 の機能（維持）:
     429 フォールバックチェーン / responseMimeType キャッシュ /
     30 秒 fetch タイムアウト / テキスト抽出パーサー

   レベル別制約（LEVEL_CFG 実装値と一致）:
     Lv0: 制約なし (3本, 4×4グリッド, ヒント2本)
     Lv1: 交差0-5  (4本, 4×4グリッド, ヒント2本)
     Lv2: 交差2-5  (4本, 4×4グリッド, ヒントなし)
     Lv3: 交差0-8  (5本, 5×5グリッド, ヒントなし)

   外部依存なし・完全自己完結。
   交差判定 _cross は problems.js の実装と完全一致。
===================================================================== */

const _G = (() => {

/* ====================================================================
   § 1. 定数
==================================================================== */

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const MODEL_CACHE_KEY = 'gemini_model_v3';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;       // 24時間

const NO_MIME_CACHE_KEY = 'gemini_no_mime_v1';
const NO_MIME_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7日間

// 429レート制限フォールバックチェーン
// RPD: gemini-2.5-flash=20, gemini-2.5-flash-lite=20,
//      gemini-3.1-flash-lite-preview=500
const FALLBACK_MODEL_CHAIN = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite-preview'
];

// 1モデルあたりの 429 許容回数
const MAX_429_PER_MODEL = 3;

// 1モデルあたりの最大試行回数
const MAX_ATTEMPTS_PER_MODEL = 5;

// レベル別設定
// gridN: 座標最大値 (グリッドサイズ = gridN + 1)
const LEVEL_CFG = {
  0: { lines: 3, gridN: 3, lo: 0, hi: 6, hints: 2 },
  1: { lines: 4, gridN: 3, lo: 0, hi: 5, hints: 2 },
  2: { lines: 4, gridN: 3, lo: 2, hi: 5, hints: 0 },
  3: { lines: 5, gridN: 4, lo: 0, hi: 8, hints: 0 }
};

/* ====================================================================
   § 2. 交差判定ヘルパー（problems.js の _cross と完全一致）
==================================================================== */

function _cross(ax, ay, bx, by, cx, cy, dx, dy) {
  if ((ax === cx && ay === cy) || (ax === dx && ay === dy)) return false;
  if ((bx === cx && by === cy) || (bx === dx && by === dy)) return false;
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function _countCross(lines) {
  let n = 0;
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      if (_cross(
        lines[i].x1, lines[i].y1, lines[i].x2, lines[i].y2,
        lines[j].x1, lines[j].y1, lines[j].x2, lines[j].y2
      )) n++;
  return n;
}

/**
 * 2線分が同一直線上にあり、かつ共有領域を持つか判定する。
 * 端点のみの接触（tMax==0 または tMin==1）は許容する。
 */
function _isCollinearOverlap(a, b) {
  const dxA = a.x2 - a.x1, dyA = a.y2 - a.y1;
  const cross1 = dxA * (b.y1 - a.y1) - dyA * (b.x1 - a.x1);
  const cross2 = dxA * (b.y2 - a.y1) - dyA * (b.x2 - a.x1);
  if (cross1 !== 0 || cross2 !== 0) return false;
  const len2 = dxA * dxA + dyA * dyA;
  if (len2 === 0) return false;
  const t1 = (dxA * (b.x1 - a.x1) + dyA * (b.y1 - a.y1)) / len2;
  const t2 = (dxA * (b.x2 - a.x1) + dyA * (b.y2 - a.y1)) / len2;
  const tMin = Math.min(t1, t2);
  const tMax = Math.max(t1, t2);
  return tMax > 0 && tMin < 1;
}

function _hasCollinearOverlap(lines) {
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      if (_isCollinearOverlap(lines[i], lines[j])) return true;
  return false;
}

/* ====================================================================
   § 3. バリデーション
==================================================================== */

function _validate(problem, cfg) {
  const n = _countCross(problem.lines);
  return n >= cfg.lo && n <= cfg.hi;
}

/* ====================================================================
   § 4. 正規化（AI 生出力 → 問題オブジェクト）
==================================================================== */

/**
 * Step1: 端点一致重複を除去
 * Step2: コリニア重複を検出 → null 返却（問題全体を棄却）
 * 線分数不一致の場合も null 返却
 */
function _normalise(raw, level) {
  const cfg  = LEVEL_CFG[level] ?? LEVEL_CFG[1];
  const maxC = cfg.gridN;
  const clamp = v => Math.max(0, Math.min(maxC, Math.round(Number(v) || 0)));

  let lines = (raw.lines || [])
    .map(l => ({
      x1: clamp(l.x1 ?? l.x ?? 0),
      y1: clamp(l.y1 ?? l.y ?? 0),
      x2: clamp(l.x2 ?? (l.x + 1) ?? 1),
      y2: clamp(l.y2 ?? (l.y + 1) ?? 1)
    }))
    .filter(l => !(l.x1 === l.x2 && l.y1 === l.y2));

  // Step1: 端点一致重複を除去
  const seen = new Set();
  lines = lines.filter(l => {
    const key =
      (l.x1 < l.x2 || (l.x1 === l.x2 && l.y1 <= l.y2))
        ? `${l.x1},${l.y1},${l.x2},${l.y2}`
        : `${l.x2},${l.y2},${l.x1},${l.y1}`;
    if (seen.has(key)) {
      console.warn(`[gemini] 端点重複を除去: (${l.x1},${l.y1})-(${l.x2},${l.y2})`);
      return false;
    }
    seen.add(key);
    return true;
  });

  // Step2: コリニア重複チェック → 問題全体を棄却
  if (_hasCollinearOverlap(lines)) {
    console.warn('[gemini] コリニア重複を検出 → この問題を棄却');
    return null;
  }

  if (lines.length !== cfg.lines) return null;

  const hintLines = lines.slice(0, cfg.hints);
  return {
    level,
    grid: { cols: cfg.gridN + 1, rows: cfg.gridN + 1 },
    lines,
    hintLines
  };
}

/* ====================================================================
   § 5. テキスト抽出パーサー
==================================================================== */

function _extractJsonArray(text) {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();

  const candidates = _extractAllArrayStrings(stripped);
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 &&
          parsed.every(item => typeof item === 'object' && item !== null)) {
        return parsed;
      }
    } catch (_) {}
  }

  const objCandidates = _extractAllObjectStrings(stripped);
  objCandidates.sort((a, b) => b.length - a.length);
  for (const candidate of objCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const val of Object.values(parsed)) {
          if (Array.isArray(val) && val.length > 0 &&
              val.every(item => typeof item === 'object' && item !== null)) {
            console.log('[gemini] パターンA検出: オブジェクトラッパーをアンラップしました');
            return val;
          }
        }
      }
    } catch (_) {}
  }

  const lineObjects = [];
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && 'lines' in obj) lineObjects.push(obj);
      } catch (_) {}
    }
  }
  if (lineObjects.length > 0) {
    console.log(`[gemini] パターンB検出: 改行区切りオブジェクト ${lineObjects.length} 件を収集`);
    return lineObjects;
  }

  console.warn('[gemini] テキストから JSON 配列を抽出できませんでした');
  return null;
}

function _extractAllArrayStrings(text) {
  const results = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') { if (depth === 0) start = i; depth++; }
    else if (text[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) { results.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return results;
}

function _extractAllObjectStrings(text) {
  const results = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) { results.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return results;
}

/* ====================================================================
   § 6. responseMimeType 非対応フラグのキャッシュ管理
==================================================================== */

function _isNoMimeCached(model) {
  try {
    const raw = localStorage.getItem(NO_MIME_CACHE_KEY);
    if (!raw) return false;
    const cache = JSON.parse(raw);
    const entry = cache[model];
    if (!entry) return false;
    const isValid = (Date.now() - entry.ts) < NO_MIME_CACHE_TTL;
    if (!isValid) {
      delete cache[model];
      localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));
      console.log(`[gemini] responseMimeType 非対応フラグ期限切れ（${model}）→ 再挑戦します`);
    }
    return isValid;
  } catch (_) { return false; }
}

function _setNoMimeCache(model) {
  try {
    const raw   = localStorage.getItem(NO_MIME_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[model] = { ts: Date.now() };
    localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));
    const retryDate = new Date(Date.now() + NO_MIME_CACHE_TTL).toLocaleDateString('ja-JP');
    console.log(
      `[gemini] ${model} を responseMimeType 非対応としてキャッシュ。` +
      `${retryDate} 以降に自動再挑戦します。`
    );
  } catch (_) {}
}

function _clearNoMimeCache(model) {
  try {
    if (!model) { localStorage.removeItem(NO_MIME_CACHE_KEY); return; }
    const raw = localStorage.getItem(NO_MIME_CACHE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    delete cache[model];
    localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

/* ====================================================================
   § 7. モデルキャッシュ管理
==================================================================== */

function _loadCachedModel() {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if (!raw) return null;
    const { model, ts } = JSON.parse(raw);
    if (Date.now() - ts < MODEL_CACHE_TTL) return model;
  } catch (_) {}
  return null;
}

function _saveModel(model) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ model, ts: Date.now() }));
  } catch (_) {}
}

function clearModelCache() {
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch (_) {}
}

/* ====================================================================
   § 8. （廃止）モデル解決
   v5.0 以降 generateProblems() が FALLBACK_MODEL_CHAIN を直接走査する
   ため、_probeModel / _fetchAvailableModels / resolveModel は削除済み。
==================================================================== */

/* ====================================================================
   § 9. プロンプト生成
==================================================================== */

function _buildPrompt(level, count) {
  const cfg = LEVEL_CFG[level] ?? LEVEL_CFG[1];
  const { lines: lineCount, gridN, lo, hi } = cfg;

  return `You are generating line puzzle problems for a visual math game for young children.

Rules:
- Each problem has exactly ${lineCount} line segments on a ${gridN + 1}x${gridN + 1} grid.
- All coordinates are integers in the range [0, ${gridN}] (inclusive).
- No zero-length lines (x1==x2 AND y1==y2 is forbidden).
- Each line segment must be VISUALLY DISTINCT. Two segments must NOT overlap in any way:
  (a) Identical endpoints (even reversed): {x1,y1,x2,y2} == {x2,y2,x1,y1} is forbidden.
  (b) Collinear overlap: if two segments lie on the same infinite line AND share any common
      region (one segment fully or partially contains the other), that is forbidden.
      Example of FORBIDDEN collinear overlap:
        Segment A: (0,0)-(3,3), Segment B: (1,1)-(2,2)  <- B is inside A, FORBIDDEN
        Segment A: (0,0)-(2,2), Segment B: (1,1)-(3,3)  <- A and B partially overlap, FORBIDDEN
      Example of ALLOWED collinear non-overlap:
        Segment A: (0,0)-(1,1), Segment B: (2,2)-(3,3)  <- same direction but no shared region, OK
- The number of STRICT INTERNAL intersections must be between ${lo} and ${hi} (inclusive).
  - "Strict internal" means two segments cross at a point that is interior to BOTH segments.
  - Shared endpoints do NOT count as intersections.
  - A point touching only one segment's endpoint does NOT count.
- Generate exactly ${count} distinct problems.

Self-check before outputting each problem:
1. For every pair of segments (A, B):
   a. Confirm they do not have identical endpoints (including reversed).
   b. Check if A and B are collinear (lie on the same infinite line).
      If collinear, confirm they share NO common point or region.
2. Count the total STRICT INTERNAL intersections.
3. Confirm the count is in [${lo}, ${hi}].
4. If any check fails, redesign the problem and recheck from step 1.

Output ONLY a JSON array, no markdown, no explanation:
[
  { "lines": [
      {"x1":0,"y1":0,"x2":2,"y2":3},
      ...${lineCount} lines total...
  ]},
  ...${count} problems total...
]`;
}

/* ====================================================================
   § 10. フォールバック問題バンク
==================================================================== */

const _FALLBACK = {
  0: [
    { lines: [{ x1:0,y1:0,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:1 },{ x1:0,y1:2,x2:3,y2:2 }] },
    { lines: [{ x1:0,y1:0,x2:0,y2:3 },{ x1:1,y1:0,x2:1,y2:3 },{ x1:2,y1:0,x2:2,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:3 },{ x1:0,y1:3,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:1 }] },
    { lines: [{ x1:1,y1:0,x2:1,y2:3 },{ x1:2,y1:0,x2:2,y2:3 },{ x1:0,y1:1,x2:3,y2:1 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:0 },{ x1:0,y1:3,x2:3,y2:3 },{ x1:1,y1:0,x2:2,y2:3 }] }
  ],
  1: [
    { lines: [{ x1:0,y1:0,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:1 },{ x1:0,y1:2,x2:3,y2:2 },{ x1:0,y1:3,x2:3,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:1,y2:3 },{ x1:1,y1:0,x2:0,y2:3 },{ x1:2,y1:0,x2:3,y2:1 },{ x1:2,y1:2,x2:3,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:1,y2:3 },{ x1:1,y1:0,x2:0,y2:3 },{ x1:2,y1:0,x2:3,y2:3 },{ x1:3,y1:0,x2:2,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:2 },{ x1:0,y1:2,x2:3,y2:0 },{ x1:1,y1:0,x2:0,y2:3 },{ x1:3,y1:2,x2:3,y2:3 }] },
    { lines: [{ x1:0,y1:1,x2:3,y2:2 },{ x1:0,y1:2,x2:3,y2:1 },{ x1:0,y1:0,x2:3,y2:3 },{ x1:2,y1:0,x2:3,y2:0 }] }
  ],
  2: [
    { lines: [{ x1:0,y1:0,x2:1,y2:3 },{ x1:1,y1:0,x2:0,y2:3 },{ x1:2,y1:0,x2:3,y2:3 },{ x1:3,y1:0,x2:2,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:2 },{ x1:0,y1:2,x2:3,y2:0 },{ x1:1,y1:0,x2:2,y2:3 },{ x1:0,y1:3,x2:1,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:2,y2:3 },{ x1:2,y1:0,x2:0,y2:3 },{ x1:1,y1:1,x2:3,y2:3 },{ x1:3,y1:0,x2:1,y2:2 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:3 },{ x1:0,y1:3,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:2 },{ x1:0,y1:2,x2:3,y2:1 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:2 },{ x1:0,y1:2,x2:3,y2:0 },{ x1:0,y1:3,x2:3,y2:1 },{ x1:0,y1:1,x2:3,y2:3 }] }
  ],
  3: [
    { lines: [{ x1:0,y1:0,x2:4,y2:4 },{ x1:0,y1:4,x2:4,y2:0 },{ x1:0,y1:2,x2:4,y2:2 },{ x1:2,y1:0,x2:2,y2:4 },{ x1:0,y1:1,x2:4,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:4,y2:3 },{ x1:0,y1:3,x2:4,y2:0 },{ x1:1,y1:0,x2:3,y2:4 },{ x1:3,y1:0,x2:1,y2:4 },{ x1:0,y1:4,x2:4,y2:4 }] },
    { lines: [{ x1:0,y1:0,x2:4,y2:4 },{ x1:0,y1:4,x2:4,y2:0 },{ x1:0,y1:1,x2:4,y2:1 },{ x1:0,y1:3,x2:4,y2:3 },{ x1:2,y1:0,x2:2,y2:4 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:4 },{ x1:1,y1:0,x2:4,y2:4 },{ x1:0,y1:4,x2:3,y2:0 },{ x1:1,y1:4,x2:4,y2:0 },{ x1:0,y1:2,x2:4,y2:2 }] },
    { lines: [{ x1:0,y1:1,x2:4,y2:3 },{ x1:0,y1:3,x2:4,y2:1 },{ x1:1,y1:0,x2:3,y2:4 },{ x1:3,y1:0,x2:1,y2:4 },{ x1:0,y1:0,x2:4,y2:4 }] }
  ]
};

function _getFallback(level, count) {
  const pool = (
    typeof PROBLEM_BANK !== 'undefined' && PROBLEM_BANK[level]
      ? PROBLEM_BANK[level]
      : _FALLBACK[level] || _FALLBACK[1]
  ).slice();

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const cfg = LEVEL_CFG[level] ?? LEVEL_CFG[1];
  return pool.slice(0, count).map(p => ({
    level,
    grid: p.grid ?? { cols: cfg.gridN + 1, rows: cfg.gridN + 1 },
    lines: p.lines,
    hintLines: p.hintLines || p.lines.slice(0, cfg.hints)
  }));
}

/* ====================================================================
   § 11. API 送信コア【Fix-E: JSON パースロジック全面改修】
==================================================================== */

/**
 * 指定モデルに問題生成リクエストを送り、{ raw, status } を返す。
 *
 * 【Fix-E】text の取り出し方を改修:
 *   - part?.text が非空文字列のときのみ text として使用。
 *     undefined / null / 空文字の場合は null 扱い。
 *   - JSON mode + text あり  → JSON.parse 直接試行。配列でなければ
 *                               _extractJsonArray へ委譲。
 *   - JSON mode + text なし  → レスポンス全体を文字列化して
 *                               _extractJsonArray を試みる。
 *                               それでも null → no-mime キャッシュ記録
 *                               + null 返却（呼び出し元で text mode 再試行）。
 *   - テキストモード          → _extractJsonArray で抽出（従来通り）。
 *   - デバッグ用に part キー一覧と text 長をログ出力。
 *
 * @param {string}  model
 * @param {string}  apiKey
 * @param {string}  prompt
 * @param {boolean} [forcePlain=false]
 * @returns {Promise<{raw: Array|null, status: number}>}
 */
async function _callApi(model, apiKey, prompt, forcePlain = false) {
  const generationConfig = {
    temperature:     0.7,
    maxOutputTokens: 2048
  };

  const useJsonMode = !forcePlain && !_isNoMimeCached(model);
  if (useJsonMode) generationConfig.responseMimeType = 'application/json';

  console.log(
    `[gemini] _callApi: ${model} / ` +
    `モード: ${useJsonMode ? 'JSON' : 'テキスト（抽出パース）'}`
  );

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 30000);

  let resp;
  try {
    resp = await fetch(
      `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  ctrl.signal,
        body:    JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig
        })
      }
    );
    clearTimeout(tid);
  } catch (e) {
    clearTimeout(tid);
    const isTimeout = e.name === 'AbortError';
    console.warn(`[gemini] fetch ${isTimeout ? 'タイムアウト' : 'ネットワークエラー'}: ${model}`);
    return { raw: null, status: isTimeout ? 408 : 0 };
  }

  // HTTP 400: responseMimeType 非対応 → テキストモードで即時リトライ
  if (resp.status === 400 && useJsonMode) {
    console.warn(`[gemini] HTTP 400 → ${model} を no-mime キャッシュに記録し、テキストモードで再試行`);
    _setNoMimeCache(model);
    return _callApi(model, apiKey, prompt, true);
  }

  if (!resp.ok) {
    console.warn(`[gemini] HTTP ${resp.status}: ${model}`);
    return { raw: null, status: resp.status };
  }

  let data;
  try { data = await resp.json(); }
  catch (e) {
    console.warn('[gemini] レスポンス JSON パースエラー:', e);
    return { raw: null, status: 200 };
  }

  // ── 【Fix-E】text の安全な取り出し ──────────────────────────────
  const part = data?.candidates?.[0]?.content?.parts?.[0];
  const rawText = part?.text;
  const text = (typeof rawText === 'string' && rawText.trim().length > 0)
    ? rawText.trim()
    : null;

  console.log('[gemini] part keys:', part ? Object.keys(part) : 'no part');
  console.log('[gemini] text length:', text !== null ? text.length : 'null (空またはなし)');

  let problems = null;

  if (useJsonMode) {
    if (text !== null) {
      // JSON mode + text あり: 直接パース → 配列チェック → fallback to extractor
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          problems = parsed;
          console.log(`[gemini] JSON.parse 成功: ${problems.length} 件`);
        } else {
          console.warn('[gemini] JSON.parse 結果が配列でない → _extractJsonArray へ委譲');
          problems = _extractJsonArray(text);
        }
      } catch (e) {
        console.warn('[gemini] JSON.parse 失敗 → _extractJsonArray へ委譲:', e.message);
        problems = _extractJsonArray(text);
      }
    } else {
      // JSON mode + text なし: レスポンス全体を文字列化して抽出試行
      console.warn('[gemini] text が null → レスポンス全体から抽出を試みます');
      const fallbackText = JSON.stringify(data);
      problems = _extractJsonArray(fallbackText);

      if (!problems || problems.length === 0) {
        // 全手段失敗 → no-mime キャッシュを記録してテキストモードで再試行
        console.warn('[gemini] 全手段失敗 → no-mime キャッシュを記録し、テキストモードで再試行');
        _setNoMimeCache(model);
        return _callApi(model, apiKey, prompt, true);
      }
    }
  } else {
    // テキストモード: _extractJsonArray で抽出
    problems = _extractJsonArray(text ?? '');
  }

  return { raw: problems, status: resp.status };
}

/* ====================================================================
   § 12. レスポンス検証・正規化
==================================================================== */

/**
 * _callApi が返した raw 配列を正規化・バリデーションして
 * 有効な問題だけを返す。
 *
 * @param {Array|null} raw
 * @param {number}     level
 * @param {number}     need  - 必要問題数
 * @returns {Array}          - 有効問題の配列（空の場合あり）
 */
function _processRaw(raw, level, need) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const cfg = LEVEL_CFG[level] ?? LEVEL_CFG[1];

  const valid = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const problem = _normalise(item, level);
    if (!problem) continue;
    if (!_validate(problem, cfg)) {
      console.warn('[gemini] 交差数制約違反 → 棄却');
      continue;
    }
    valid.push(problem);
    if (valid.length >= need) break;
  }
  return valid;
}

/* ====================================================================
   § 13. メイン API: generateProblems
==================================================================== */

/**
 * 指定レベルの問題を count 件生成して返す。
 *
 * フロー:
 * 1. FALLBACK_MODEL_CHAIN を順番に試行
 * 2. 1モデルあたり最大 MAX_ATTEMPTS_PER_MODEL 回
 * 3. 429 が MAX_429_PER_MODEL 回連続したら次のモデルへ
 * 4. 401/403 → APIキーエラー、即座にフォールバックバンクへ
 * 5. 全モデル失敗 → _getFallback() を返す
 *
 * @param {number} level
 * @param {number} [count=5]
 * @param {string} apiKey
 * @returns {Promise<Array>}
 */
async function generateProblems(level, count = 5, apiKey) {
  if (!apiKey) {
    console.log('[gemini] APIキーなし → フォールバックバンクを使用');
    return _getFallback(level, count);
  }

  const prompt = _buildPrompt(level, count);

  for (const model of FALLBACK_MODEL_CHAIN) {
    let attempts    = 0;
    let count429    = 0;

    console.log(`[gemini] モデル試行開始: ${model}`);

    while (attempts < MAX_ATTEMPTS_PER_MODEL) {
      attempts++;
      console.log(`[gemini] ${model} 試行 ${attempts}/${MAX_ATTEMPTS_PER_MODEL}`);

      const { raw, status } = await _callApi(model, apiKey, prompt);

      // 認証エラー → 即フォールバック
      if (status === 401 || status === 403) {
        console.error('[gemini] 認証エラー → フォールバックバンクを使用');
        return _getFallback(level, count);
      }

      // タイムアウト / ネットワークエラー
      if (status === 408 || status === 0) {
        console.warn(`[gemini] タイムアウト/ネットワークエラー (${model})`);
        break; // 次のモデルへ
      }

      // レート制限
      if (status === 429) {
        count429++;
        console.warn(`[gemini] 429 レート制限 (${model}): ${count429}/${MAX_429_PER_MODEL}`);
        if (count429 >= MAX_429_PER_MODEL) {
          console.warn(`[gemini] ${model} の 429 上限到達 → 次モデルへ`);
          break;
        }
        // 指数バックオフ（1秒 × 2^(count429-1)）
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, count429 - 1)));
        continue;
      }

      // パース・正規化・バリデーション
      const valid = _processRaw(raw, level, count);
      if (valid.length >= count) {
        _saveModel(model);
        console.log(`[gemini] ${model} で ${valid.length} 件生成成功`);
        return valid.slice(0, count);
      }

      if (valid.length > 0) {
        // 一部有効 → 不足分は次の試行で補わず、そのまま返す（品質重視）
        // ただし 1 件以上あれば成功扱い（呼び出し元で追加リクエスト可）
        console.warn(`[gemini] ${model}: ${valid.length}/${count} 件のみ有効`);
      } else {
        console.warn(`[gemini] ${model}: 有効問題 0 件`);
      }
    }
  }

  console.warn('[gemini] 全モデル失敗 → フォールバックバンクを使用');
  return _getFallback(level, count);
}

/* ====================================================================
   § 14. API キー管理
==================================================================== */

const API_KEY_STORAGE = 'gemini_api_key';

function saveApiKey(key) {
  try { localStorage.setItem(API_KEY_STORAGE, key); } catch (_) {}
}

function loadApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch (_) { return ''; }
}

/* ====================================================================
   § 15. エクスポート
==================================================================== */

return {
  generateProblems,
  saveApiKey,
  loadApiKey,
  clearModelCache
};

})(); // end _G IIFE

// グローバルスコープへ公開
const generateProblems = _G.generateProblems;
const saveApiKey       = _G.saveApiKey;
const loadApiKey       = _G.loadApiKey;
const clearModelCache  = _G.clearModelCache;
