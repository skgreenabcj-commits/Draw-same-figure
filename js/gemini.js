'use strict';

/* =====================================================================
   gemini.js  v5.0
   -----------------------------------------------------------------------
   v5.0 からの変更点（v4.2 → v5.0）:
     【新機能】429レート制限時のモデルフォールバックチェーン
       - FALLBACK_MODEL_CHAIN を §1 に定数として定義
       - gemini-2.5-flash → gemini-2.5-flash-lite →
         gemini-3.1-flash-lite-preview の順で自動切替
       - 1モデルあたりの429許容回数(MAX_429_PER_MODEL)を超えたら
         即座に次モデルへ移行し、無限ループを完全防止
       - 全モデル失敗時は _getFallback() へフォールオーバー
       - _extractAndValidate() を内部ヘルパーとして切り出し、
         generateProblems() の可読性を向上

   v4.2 の機能（維持）:
     【Bug修正】_fetchAvailableModels() 8秒タイムアウト
     【Bug修正】_callApi() 30秒 fetchタイムアウト
     【Bug修正】429 無限ループ防止（MAX_RETRY_429）
     【新機能】responseMimeType 非対応モデル自動検出 + 7日キャッシュ
     【改善】テキスト抽出パーサーの強化
       - パターンA（オブジェクトラッパー）自動アンラップ
       - パターンB（改行区切り個別オブジェクト）検出
     【既存機能】動的モデル選択（並列プローブ + 24時間キャッシュ）

   レベル別制約:
     Lv0: 交差0-2  (4本, 4×4グリッド, ヒント3本)
     Lv1: 交差0-3  (4本, 4×4グリッド, ヒント2本)
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

// ── モデルキャッシュ ──────────────────────────────────────────────────
const MODEL_CACHE_KEY = 'gemini_model_v3';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;        // 24時間（ミリ秒）

// ── responseMimeType 非対応フラグキャッシュ ───────────────────────────
const NO_MIME_CACHE_KEY = 'gemini_no_mime_v1';
const NO_MIME_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;  // 7日間（ミリ秒）

// ── resolveModel() 用優先モデル・フォールバックリスト ─────────────────
const PREFERRED_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.0-pro'
];

// ── 429レート制限時のフォールバックチェーン（v5.0 新規追加）────────────
// 各モデルの無料枠 RPD: gemini-2.5-flash=20, gemini-2.5-flash-lite=20,
//                       gemini-3.1-flash-lite-preview=500
// → RPD が最も大きい gemini-3.1-flash-lite-preview を最終砦に配置する。
const FALLBACK_MODEL_CHAIN = [
  'gemini-2.5-flash',             // プライマリ
  'gemini-2.5-flash-lite',        // 第1フォールバック（同世代・同品質）
  'gemini-3.1-flash-lite-preview' // 第2フォールバック（RPD500・最終砦）
];

// ── レベル別設定 ──────────────────────────────────────────────────────
// lines: 線分数 / gridN: 座標最大値(=グリッドサイズ-1) /
// lo,hi: 許容交差数範囲 / hints: ヒント本数
const LEVEL_CFG = {
  0: { lines: 3, gridN: 3, lo: 0, hi: 6, hints: 2 }, // ← lines:4→3, hi:6(制約なし相当), hints:3→2
  1: { lines: 4, gridN: 3, lo: 0, hi: 5, hints: 2 }, // ← hi:3→5
  2: { lines: 4, gridN: 3, lo: 2, hi: 5, hints: 0 },
  3: { lines: 5, gridN: 4, lo: 0, hi: 8, hints: 0 }
};

/* ====================================================================
   § 2. 交差判定ヘルパー（problems.js の _cross と完全一致）
==================================================================== */

/**
 * 2線分 AB と CD が厳密に内部で交差するか判定する。
 * 端点共有・端点が相手の線分上にある場合は false。
 *
 * @param {number} ax @param {number} ay  線分ABの始点
 * @param {number} bx @param {number} by  線分ABの終点
 * @param {number} cx @param {number} cy  線分CDの始点
 * @param {number} dx @param {number} dy  線分CDの終点
 * @returns {boolean}
 */
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

/**
 * 線分配列内の全ペアについて厳密内部交差数を返す。
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} lines
 * @returns {number}
 */
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

/* ====================================================================
   § 3. バリデーション
==================================================================== */

/**
 * 問題オブジェクトがレベルの交差数制約を満たすか確認する。
 * @param {Object} problem - { lines: Array }
 * @param {Object} cfg     - LEVEL_CFG の1エントリ
 * @returns {boolean}
 */
function _validate(problem, cfg) {
  const n = _countCross(problem.lines);
  return n >= cfg.lo && n <= cfg.hi;
}

/* ====================================================================
   § 4. 正規化（AI 生出力 → 問題オブジェクト）
==================================================================== */

/**
 * Gemini が返した JSON の1要素を受け取り、座標クランプ・長さゼロ除去・
 * hintLines 付与を行って問題オブジェクトを返す。
 * 線分数が設定と合わない場合は null を返す。
 *
 * @param {Object} raw   - AI が返した1問分の生データ
 * @param {number} level - レベル番号
 * @returns {Object|null}
 */
function _normalise(raw, level) {
  const cfg  = LEVEL_CFG[level] ?? LEVEL_CFG[1];
  const maxC = cfg.gridN;

  // 座標を [0, maxC] の整数にクランプ
  const clamp = v => Math.max(0, Math.min(maxC, Math.round(Number(v) || 0)));

  const lines = (raw.lines || [])
    .map(l => ({
      x1: clamp(l.x1 ?? l.x ?? 0),
      y1: clamp(l.y1 ?? l.y ?? 0),
      x2: clamp(l.x2 ?? (l.x + 1) ?? 1),
      y2: clamp(l.y2 ?? (l.y + 1) ?? 1)
    }))
    .filter(l => !(l.x1 === l.x2 && l.y1 === l.y2)); // 長さゼロの線分を除去

  // 線分数が設定値と一致しなければ無効
  if (lines.length !== cfg.lines) return null;

  // ヒント線は先頭 cfg.hints 本の線分オブジェクトをそのまま使用
  // （数値インデックス配列ではなくオブジェクト配列にすることで
  //   canvas.js の drawLine() / app.js の judgeAnswer() と型が一致する）
  const hintLines = lines.slice(0, cfg.hints);

  return {
    level,
    grid: { cols: cfg.gridN + 1, rows: cfg.gridN + 1 },
    lines,
    hintLines
  };
}

/* ====================================================================
   § 5. テキスト抽出パーサー（responseMimeType 非対応モデル向け）
==================================================================== */

/**
 * Gemini がテキストモードで返したレスポンス文字列から
 * JSON 配列を抽出して返す。
 *
 * 対処するパターン:
 *   A. JSON がオブジェクトラッパーに包まれている → 内側の配列を取り出す
 *   B. 複数の JSON ブロックが混在 → 最も長い配列ブロックを選ぶ
 *   C. 座標値が文字列で返る → _normalise の clamp で吸収
 *   D. 改行区切り個別オブジェクト → 行ごとにパースして収集
 *
 * @param {string} text
 * @returns {Array|null}
 */
function _extractJsonArray(text) {
  if (!text) return null;

  // ── ステップ1: マークダウンコードブロックを除去 ──────────────────
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();

  // ── ステップ2: テキスト中の全 '[...]' ブロックを収集（スタックベース）
  const candidates = _extractAllArrayStrings(stripped);

  // ── ステップ3: 最も長い配列文字列を優先してパース試行 ────────────
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 &&
          parsed.every(item => typeof item === 'object' && item !== null)) {
        return parsed;
      }
    } catch (_) { /* 次の候補へ */ }
  }

  // ── ステップ4: パターンA（オブジェクトラッパー）────────────────────
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
    } catch (_) { /* 次の候補へ */ }
  }

  // ── ステップ5: パターンB（改行区切り個別オブジェクト）──────────────
  const lineObjects = [];
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && 'lines' in obj) lineObjects.push(obj);
      } catch (_) { /* 無視 */ }
    }
  }
  if (lineObjects.length > 0) {
    console.log(`[gemini] パターンB検出: 改行区切りオブジェクト ${lineObjects.length} 件を収集`);
    return lineObjects;
  }

  console.warn('[gemini] テキストから JSON 配列を抽出できませんでした');
  return null;
}

/**
 * 文字列中のすべての '[...]' ブロックをスタックベースで抽出する。
 * @param {string} text
 * @returns {string[]}
 */
function _extractAllArrayStrings(text) {
  const results = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
}

/**
 * 文字列中のすべての '{...}' ブロックをスタックベースで抽出する。
 * @param {string} text
 * @returns {string[]}
 */
function _extractAllObjectStrings(text) {
  const results = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
}

/* ====================================================================
   § 6. responseMimeType 非対応フラグのキャッシュ管理
==================================================================== */

/**
 * 指定モデルが responseMimeType 非対応としてキャッシュされているか確認する。
 * TTL（7日）を超えたエントリは自動削除して false を返す。
 * @param {string} model
 * @returns {boolean}
 */
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
      console.log(
        `[gemini] responseMimeType 非対応フラグ期限切れ（${model}）→ 再挑戦します`
      );
    }
    return isValid;
  } catch (_) { return false; }
}

/**
 * 指定モデルを responseMimeType 非対応としてキャッシュに記録する。
 * @param {string} model
 */
function _setNoMimeCache(model) {
  try {
    const raw   = localStorage.getItem(NO_MIME_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[model] = { ts: Date.now() };
    localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));
    const retryDate = new Date(Date.now() + NO_MIME_CACHE_TTL)
      .toLocaleDateString('ja-JP');
    console.log(
      `[gemini] ${model} を responseMimeType 非対応としてキャッシュ。` +
      `${retryDate} 以降に自動再挑戦します。`
    );
  } catch (_) { /* localStorage 書き込みエラーは無視 */ }
}

/**
 * responseMimeType 非対応フラグをクリアする。
 * 引数なしで全クリア、モデル名指定で個別クリア。
 * @param {string} [model]
 */
function _clearNoMimeCache(model) {
  try {
    if (!model) {
      localStorage.removeItem(NO_MIME_CACHE_KEY);
      console.log('[gemini] responseMimeType 非対応フラグを全クリアしました');
      return;
    }
    const raw = localStorage.getItem(NO_MIME_CACHE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    delete cache[model];
    localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));
  } catch (_) { /* 無視 */ }
}

/* ====================================================================
   § 7. モデルキャッシュ管理
==================================================================== */

/**
 * localStorage からモデルキャッシュを読み込む。TTL 超過時は null。
 * @returns {string|null}
 */
function _loadCachedModel() {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if (!raw) return null;
    const { model, ts } = JSON.parse(raw);
    if (Date.now() - ts < MODEL_CACHE_TTL) return model;
  } catch (_) {}
  return null;
}

/**
 * モデル名をタイムスタンプ付きで localStorage に保存する。
 * @param {string} model
 */
function _saveModel(model) {
  try {
    localStorage.setItem(
      MODEL_CACHE_KEY,
      JSON.stringify({ model, ts: Date.now() })
    );
  } catch (_) {}
}

/**
 * モデルキャッシュをクリアする（公開 API）。
 * APIキー変更時・認証エラー時に app.js からも呼び出せる。
 */
function clearModelCache() {
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch (_) {}
}

/* ====================================================================
   § 8. モデル解決（プローブ + キャッシュ）
==================================================================== */

/**
 * 指定モデルに 5 秒タイムアウトで疎通確認リクエストを送る。
 * 応答が HTTP 2xx なら true を返す。
 *
 * @param {string} model
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
async function _probeModel(model, apiKey) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(
      `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  ctrl.signal,
        body:    JSON.stringify({
          contents:         [{ parts: [{ text: 'Reply with the single word: ready' }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      }
    );
    clearTimeout(tid);
    return r.ok;
  } catch (e) {
    clearTimeout(tid);
    return false;
  }
}

/**
 * Gemini API の /models エンドポイントから generateContent 対応モデル一覧を取得する。
 * AbortController で 8 秒タイムアウトを設定。タイムアウト・エラー時は null を返す。
 *
 * @param {string} apiKey
 * @returns {Promise<string[]|null>}
 */
async function _fetchAvailableModels(apiKey) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(
      `${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`,
      { signal: ctrl.signal }
    );
    clearTimeout(tid);
    if (!r.ok) return null;
    const data = await r.json();
    return (data.models || [])
      .filter(m =>
        (m.supportedGenerationMethods || []).includes('generateContent')
      )
      .map(m => m.name.replace('models/', ''));
  } catch (_) {
    clearTimeout(tid);
    console.warn(
      '[gemini] モデル一覧の取得がタイムアウトまたは失敗しました。' +
      'フォールバックリストを使用します。'
    );
    return null;
  }
}

/**
 * 最適なモデルを以下の優先順位で解決する:
 *   1. localStorage キャッシュにヒットすればそれを返す（24時間有効）
 *   2. PREFERRED_MODEL をプローブ → 成功すれば採用
 *   3. API からモデル一覧を取得して既知リストと照合（8秒タイムアウト付き）
 *   4. 上位 3 モデルを並列プローブ → 最速で成功したものを採用
 *   5. 残りを直列プローブ
 *   6. 全滅した場合は 'gemini-2.5-flash' をデフォルトとして返す
 *
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function resolveModel(apiKey) {
  const cached = _loadCachedModel();
  if (cached) {
    console.log(`[gemini] キャッシュ済みモデルを使用: ${cached}`);
    return cached;
  }

  console.log(`[gemini] 優先モデルを確認中: ${PREFERRED_MODEL}`);
  if (await _probeModel(PREFERRED_MODEL, apiKey)) {
    console.log(`[gemini] 優先モデルを選択: ${PREFERRED_MODEL}`);
    _saveModel(PREFERRED_MODEL);
    return PREFERRED_MODEL;
  }

  const available  = await _fetchAvailableModels(apiKey);
  let   candidates = FALLBACK_MODELS.slice();
  if (available) {
    const apiSet = new Set(available);
    const known  = candidates.filter(m => apiSet.has(m));
    const extra  = available.filter(
      m => !candidates.includes(m) && m.startsWith('gemini')
    );
    candidates = [...known, ...extra];
    console.log(
      `[gemini] API取得候補: ${candidates.slice(0, 5).join(', ')}…`
    );
  }

  const top3   = candidates.slice(0, 3);
  const rest   = candidates.slice(3);
  const top3Ok = await Promise.all(top3.map(m => _probeModel(m, apiKey)));
  for (let i = 0; i < top3.length; i++) {
    if (top3Ok[i]) {
      console.log(`[gemini] 並列プローブで選択: ${top3[i]}`);
      _saveModel(top3[i]);
      return top3[i];
    }
  }
  for (const m of rest) {
    if (await _probeModel(m, apiKey)) {
      console.log(`[gemini] 直列プローブで選択: ${m}`);
      _saveModel(m);
      return m;
    }
  }

  console.warn(
    '[gemini] 使用可能なモデルが見つかりません。' +
    `${FALLBACK_MODEL_CHAIN[0]} をデフォルト使用`
  );
  return FALLBACK_MODEL_CHAIN[0];
}

/* ====================================================================
   § 9. プロンプト生成
==================================================================== */

/**
 * Gemini に送るプロンプト文字列を組み立てる。
 * レベル別の線分数・グリッドサイズ・交差数制約・自己チェック手順を含む。
 *
 * @param {number} level
 * @param {number} count
 * @returns {string}
 */
function _buildPrompt(level, count) {
  const cfg = LEVEL_CFG[level] ?? LEVEL_CFG[1];
  const { lines: lineCount, gridN, lo, hi } = cfg;

  return `You are generating line puzzle problems for a visual math game.

Rules:
- Each problem has exactly ${lineCount} line segments on a ${gridN + 1}x${gridN + 1} grid.
- All coordinates are integers in the range [0, ${gridN}] (inclusive).
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

/* ====================================================================
   § 10. フォールバック問題バンク
==================================================================== */

/**
 * Gemini API が利用できない場合・全試行失敗時に使う事前検証済み問題セット。
 * problems.js の PROBLEM_BANK が利用可能な場合はそちらを優先する。
 */
const _FALLBACK = {
  0: [
    { lines: [{ x1:0,y1:0,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:1 },{ x1:0,y1:2,x2:3,y2:2 },{ x1:0,y1:3,x2:3,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:0,y2:3 },{ x1:1,y1:0,x2:1,y2:3 },{ x1:2,y1:0,x2:2,y2:3 },{ x1:3,y1:0,x2:3,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:1,y2:3 },{ x1:1,y1:0,x2:0,y2:3 },{ x1:2,y1:0,x2:3,y2:1 },{ x1:2,y1:2,x2:3,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:1,y2:3 },{ x1:1,y1:0,x2:0,y2:3 },{ x1:2,y1:0,x2:3,y2:3 },{ x1:3,y1:0,x2:2,y2:3 }] },
    { lines: [{ x1:0,y1:0,x2:3,y2:1 },{ x1:0,y1:1,x2:3,y2:0 },{ x1:0,y1:2,x2:1,y2:3 },{ x1:1,y1:2,x2:0,y2:3 }] }
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
    { lines: [{ x1:0,y1:0,x2:3,y2:3 },{ x1:0,y1:3,x2:3,y2:0 },{ x1:0,y1:1,x2:3,y2:2 },{ x1:0,y1:2,x2:3,y2:2 }] },
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

/**
 * フォールバック問題をシャッフルして必要数だけ返す。
 * problems.js の PROBLEM_BANK が利用可能な場合はそちらを優先する。
 * hintLines は線分オブジェクト配列として設定する（Bug #3 対応済み）。
 *
 * @param {number} level
 * @param {number} count
 * @returns {Array}
 */
function _getFallback(level, count) {
  const pool = (
    typeof PROBLEM_BANK !== 'undefined' && PROBLEM_BANK[level]
      ? PROBLEM_BANK[level]
      : _FALLBACK[level] || _FALLBACK[1]
  ).slice();

  // Fisher-Yates シャッフル
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const cfg = LEVEL_CFG[level] ?? LEVEL_CFG[1];
  return pool.slice(0, count).map(p => ({
    level,
    grid:      { cols: cfg.gridN + 1, rows: cfg.gridN + 1 },
    lines:     p.lines,
    hintLines: p.hintLines || p.lines.slice(0, cfg.hints)
  }));
}

/* ====================================================================
   § 11. API 送信コア（responseMimeType 自動切替 + fetchタイムアウト）
==================================================================== */

/**
 * 指定モデルに問題生成リクエストを送り、{ raw, status } を返す。
 *
 * - JSON モード: responseMimeType = 'application/json' を付与して送信。
 *   HTTP 400 が返った場合、そのモデルを非対応としてキャッシュし
 *   テキストモードで即時リトライ（forcePlain = true）。
 * - テキストモード: _extractJsonArray() でレスポンスから配列を抽出。
 * - 30 秒 fetchタイムアウト: AbortController を使用。
 *
 * @param {string}  model
 * @param {string}  apiKey
 * @param {string}  prompt
 * @param {boolean} [forcePlain=false] - true のときテキストモード強制
 * @returns {Promise<{raw: Array|null, status: number}>}
 */
async function _callApi(model, apiKey, prompt, forcePlain = false) {
  const generationConfig = {
    temperature:     0.7,
    maxOutputTokens: 2048
  };

  const useJsonMode = !forcePlain && !_isNoMimeCached(model);
  if (useJsonMode) {
    generationConfig.responseMimeType = 'application/json';
  }

  console.log(
    `[gemini] _callApi: ${model} / ` +
    `モード: ${useJsonMode ? 'JSON' : 'テキスト（抽出パース）'}`
  );

  // ── 30秒 fetchタイムアウト ────────────────────────────────────────
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
    console.error(
      `[gemini] fetch ${isTimeout ? 'タイムアウト(30秒)' : '失敗'}: ${e.message}`
    );
    return { raw: null, status: isTimeout ? 408 : 0 };
  }

  const status = resp.status;

  // ── HTTP 400: responseMimeType 非対応 → テキストモードで即時リトライ
  if (status === 400 && !forcePlain) {
    console.warn(
      `[gemini] HTTP 400 → ${model} は responseMimeType 非対応と判定。` +
      'テキストモードで再送します。'
    );
    _setNoMimeCache(model);
    return _callApi(model, apiKey, prompt, true);
  }

  if (!resp.ok) {
    console.warn(`[gemini] HTTP ${status} エラー (${model})`);
    return { raw: null, status };
  }

  // ── レスポンス JSON パース ────────────────────────────────────────
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    console.error('[gemini] レスポンス JSON パース失敗:', e.message);
    return { raw: null, status };
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // ── 問題配列の抽出 ────────────────────────────────────────────────
  let raw;
  if (useJsonMode) {
    try {
      raw = JSON.parse(text);
      if (!Array.isArray(raw)) raw = null;
    } catch (_) {
      raw = _extractJsonArray(text);
    }
  } else {
    raw = _extractJsonArray(text);
  }

  return { raw, status };
}

/* ====================================================================
   § 12. パース・バリデーションヘルパー（内部使用）
==================================================================== */

/**
 * _callApi の raw レスポンスから問題配列を正規化・検証して返す。
 * 条件を満たさない場合は null を返す。
 *
 * @param {{raw: Array|null, status: number}} result - _callApi の戻り値
 * @param {number} level
 * @param {number} count
 * @param {Object} cfg   - LEVEL_CFG の1エントリ
 * @returns {Array|null} count 件の検証済み問題配列、または null
 */
function _extractAndValidate(result, level, count, cfg) {
  const { raw } = result;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const validated = [];
  for (const item of raw) {
    if (validated.length >= count) break;
    const p = _normalise(item, level);
    if (!p) {
      console.warn('[gemini] _normalise 失敗（線分数不一致または無効）');
      continue;
    }
    if (!_validate(p, cfg)) {
      const n = _countCross(p.lines);
      console.warn(
        `[gemini] 交差数制約違反: ${n} (要求: ${cfg.lo}–${cfg.hi})`
      );
      continue;
    }
    validated.push(p);
  }

  return validated.length >= count ? validated.slice(0, count) : null;
}

/* ====================================================================
   § 13. 問題生成メイン（公開 API）  ← §13 全体をこれで差し替え
==================================================================== */

/**
 * 指定レベルの問題を count 件生成して返す。
 *
 * FALLBACK_MODEL_CHAIN を先頭から順に走査する。
 * resolveModel() は呼ばない（プローブによるRPM消費を防ぐため）。
 *
 * 各モデルの試行ルール:
 *   - MAX_ATTEMPTS_PER_MODEL 回の生成試行を行う。
 *   - 429 が MAX_429_PER_MODEL 回に達したら即座に次モデルへ。
 *   - 401/403 は認証エラーのため全体を即座に中断してフォールバック。
 *   - 408/0 はタイムアウト/ネットワークエラーのため次試行へ。
 * 全モデル失敗時は _getFallback() でローカルBANKを返す。
 *
 * @param {number} level
 * @param {number} count
 * @param {string} apiKey
 * @returns {Promise<Array>}
 */
async function generateProblems(level, count, apiKey) {
  if (!apiKey) {
    console.log('[gemini] APIキー未設定 → フォールバック問題を使用');
    return _getFallback(level, count);
  }

  const cfg    = LEVEL_CFG[level] ?? LEVEL_CFG[1];
  const prompt = _buildPrompt(level, count);

  const MAX_ATTEMPTS_PER_MODEL = 5;  // 1モデルあたりの最大生成試行数
  const MAX_429_PER_MODEL      = 3;  // 1モデルあたりの429許容回数
                                     // （1回バックオフ→2回目バックオフ→3回目でbreak）

  // ── FALLBACK_MODEL_CHAIN を先頭から順に走査 ───────────────────────
  // resolveModel() は呼ばない。チェーンの先頭が常にプライマリモデル。
  for (let mi = 0; mi < FALLBACK_MODEL_CHAIN.length; mi++) {
    const model    = FALLBACK_MODEL_CHAIN[mi];
    let attempt429 = 0;

    console.log(
      `[gemini] チェーン[${mi}] ${model} を試行開始 ` +
      `(Lv${level} / 要求${count}件)`
    );

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
      console.log(
        `[gemini] 試行 ${attempt + 1}/${MAX_ATTEMPTS_PER_MODEL} (${model})`
      );

      const result = await _callApi(model, apiKey, prompt);
      const { status } = result;

      // ── 429 レート制限 ─────────────────────────────────────────────
      if (status === 429) {
        attempt429++;
        if (attempt429 >= MAX_429_PER_MODEL) {
          console.warn(
            `[gemini] ${model}: 429 上限(${MAX_429_PER_MODEL}回)到達 → 次モデルへ`
          );
          break; // 内側ループを抜けて次モデルへ
        }
        // 指数バックオフ（2s → 4s → 8s、jitter付き、最大15s）
        const backoff = Math.min(2000 * Math.pow(2, attempt429 - 1), 15000);
        const wait    = backoff + Math.random() * 1000;
        console.warn(
          `[gemini] 429 backoff ${Math.round(wait)}ms ` +
          `(${model} ${attempt429}/${MAX_429_PER_MODEL}回目)`
        );
        await new Promise(r => setTimeout(r, wait));
        attempt--; // 試行カウントを消費しない（for の attempt++ と相殺）
        continue;
      }

      // ── 401 / 403: 認証エラー → 全体を即中断してフォールバック ─────
      if (status === 401 || status === 403) {
        console.error(
          `[gemini] 認証エラー (HTTP ${status}) → フォールバックBANKへ`
        );
        clearModelCache();
        return _getFallback(level, count);
      }

      // ── 408 / 0: タイムアウト / ネットワークエラー ───────────────
      if (status === 408 || status === 0) {
        console.warn(
          `[gemini] タイムアウト/NWエラー (${model} 試行${attempt + 1}) → 次試行へ`
        );
        continue;
      }

      // ── 正常レスポンス → パース・バリデーション ──────────────────
      const problems = _extractAndValidate(result, level, count, cfg);
      if (problems) {
        console.log(
          `[gemini] 問題生成成功: ${model} (試行${attempt + 1}/${MAX_ATTEMPTS_PER_MODEL})`
        );
        return problems;
      }

      console.warn(
        `[gemini] パース/バリデーション失敗 (${model} 試行${attempt + 1}) → 次試行へ`
      );

    } // end inner for (attempt)

    const nextModel = FALLBACK_MODEL_CHAIN[mi + 1];
    console.warn(
      `[gemini] ${model}: 全試行失敗 → ` +
      (nextModel ? `次モデル: ${nextModel}` : 'フォールバックBANKへ')
    );

  } // end outer for (mi)

  // ── 全モデル失敗 → ローカルBANKフォールバック ────────────────────
  console.warn('[gemini] 全モデル失敗 → _getFallback() を使用します');
  return _getFallback(level, count);
}


/* ====================================================================
   § 14. APIキー管理（公開 API）
==================================================================== */

/**
 * APIキーを localStorage に保存する。
 * キー変更時はモデルキャッシュと no-mime フラグを同時にクリアする。
 * @param {string} key
 */
function saveApiKey(key) {
  try {
    const prev = localStorage.getItem('gemini_api_key');
    if (prev !== key) {
      clearModelCache();
      _clearNoMimeCache();
      console.log('[gemini] APIキー変更を検出: モデルキャッシュをリセットしました');
    }
    localStorage.setItem('gemini_api_key', key);
  } catch (_) {}
}

/**
 * localStorage から APIキーを読み込む。
 * @returns {string}
 */
function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; } catch (_) { return ''; }
}

/* ====================================================================
   § 15. モジュールエクスポート
==================================================================== */

return {
  generateProblems,
  resolveModel,
  saveApiKey,
  loadApiKey,
  clearModelCache
};

})(); // end _G IIFE

// ── グローバル公開（index.html から直接参照できるようにする）────────
const { generateProblems, resolveModel, saveApiKey, loadApiKey, clearModelCache } = _G;
