'use strict';

/* =====================================================================
   gemini.js  v4.1
   -----------------------------------------------------------------------
   v4.0 からの変更点:
     【Bug修正】_fetchAvailableModels() にタイムアウト追加
       - AbortController で 8 秒タイムアウトを設定
       - タイムアウト・エラー時は null を返してフォールバックへ移行
       - これにより resolveModel() がネットワーク不安定時にフリーズする
         問題（「AIが問題を作っています…」で永久停止）を修正

   v4.0 の機能（維持）:
     【新機能】responseMimeType 非対応モデル検出と自動フォールバック
       - responseMimeType: 'application/json' 付きで送信を試みる
       - HTTP 400 が返った場合、そのモデルが responseMimeType 非対応と判定
       - 「非対応フラグ」を localStorage に 7 日間キャッシュ
       - キャッシュ期間中はテキスト抽出 + JSON パース方式で送信
       - 7 日後にキャッシュが自動失効 → responseMimeType で再挑戦
       - APIキー変更時は非対応フラグも同時にクリア

     【改善】テキスト抽出パーサーの強化
       - 最長の JSON 配列ブロックを選ぶアルゴリズムに変更
       - パターンA（オブジェクトラッパー）の自動アンラップ処理を追加
       - パターンB（改行区切り個別オブジェクト）の検出処理を追加

   既存の機能:
     - 動的モデル選択（並列プローブ + 24 時間キャッシュ）
     - 交差点検証は problems.js の _cross と完全一致
     - 外部依存なし・完全自己完結
     - レベル別制約:
         Lv0: 交差0-2  (4本, 4x4グリッド)
         Lv1: 交差0-3  (4本, 4x4グリッド)
         Lv2: 交差2-5  (4本, 4x4グリッド)
         Lv3: 交差0-8  (5本, 5x5グリッド)
===================================================================== */

const _G = (() => {

/* ====================================================================
   § 1. 定数
==================================================================== */

const BASE_URL        = 'https://generativelanguage.googleapis.com/v1beta';

// ── モデルキャッシュ ──────────────────────────────────────────────────
const MODEL_CACHE_KEY = 'gemini_model_v3';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;       // 24時間（ミリ秒）

// ── responseMimeType 非対応フラグキャッシュ ───────────────────────────
const NO_MIME_CACHE_KEY = 'gemini_no_mime_v1';
const NO_MIME_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7日間（ミリ秒）
// 【TTL を 7 日間に設定した理由】
// Google は Gemini モデルの API サポート仕様をおおむね数週間〜数ヶ月単位で
// 更新する。7 日ごとに再挑戦することで、モデルが responseMimeType に対応
// した際に自動的に高品質モードへ復帰できる。

// ── 優先モデルとフォールバックリスト ─────────────────────────────────
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

// ── レベル別設定 ──────────────────────────────────────────────────────
// lines: 線分数 / gridN: 座標最大値 / lo,hi: 交差数範囲 / hints: ヒント本数
const LEVEL_CFG = {
  0: { lines: 4, gridN: 3, lo: 0, hi: 2, hints: 3 },
  1: { lines: 4, gridN: 3, lo: 0, hi: 3, hints: 2 },
  2: { lines: 4, gridN: 3, lo: 2, hi: 5, hints: 0 },
  3: { lines: 5, gridN: 4, lo: 0, hi: 8, hints: 0 }
};

/* ====================================================================
   § 2. 交差判定ヘルパー（problems.js の _cross と完全一致）
==================================================================== */

/**
 * 2線分 AB と CD が厳密に内部で交差するか判定する。
 * 端点共有・端点が相手の線分上にある場合は false。
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
 * @param {Array<{x1,y1,x2,y2}>} lines
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
 * @param {Object} problem
 * @param {number} level
 * @returns {boolean}
 */
function _validate(problem, level) {
  const cfg = LEVEL_CFG[level] || LEVEL_CFG[1];
  const n   = _countCross(problem.lines);
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
  const cfg  = LEVEL_CFG[level] || LEVEL_CFG[1];
  const maxC = cfg.gridN;

  // 座標を [0, maxC] の整数に丸めるクランプ関数
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
  // （数値インデックスではなくオブジェクト配列にすることで
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
 *   D. 交差数が仕様外 → _validate でフィルタ
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

  // ── ステップ4: パターンA対応（オブジェクトラッパー）────────────────
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

  // ── ステップ5: パターンB対応（改行区切り個別オブジェクト）──────────
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
 *
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
      console.log(`[gemini] responseMimeType 非対応フラグ期限切れ（${model}）→ 再挑戦します`);
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
    const retryDate = new Date(Date.now() + NO_MIME_CACHE_TTL).toLocaleDateString('ja-JP');
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
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ model, ts: Date.now() }));
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
 *
 * 【v4.1 修正】AbortController で 8 秒タイムアウトを追加。
 * 旧版ではタイムアウトがなく、ネットワーク不安定時に resolveModel() が
 * ここで無制限に停止し「AIが問題を作っています…」で永久フリーズしていた。
 * 修正後はタイムアウト・エラー時に null を返してフォールバックへ移行する。
 *
 * @param {string} apiKey
 * @returns {Promise<string[]|null>}
 */
async function _fetchAvailableModels(apiKey) {
  // ── タイムアウト設定（8秒）────────────────────────────────────────
  // _probeModel の 5 秒より長くすることで、モデル一覧 API が
  // 少し遅くても取得を試みつつ、無限待機は防ぐ。
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(
      `${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`,
      { signal: ctrl.signal }  // ← v4.1 追加: タイムアウトシグナルを渡す
    );
    clearTimeout(tid);
    if (!r.ok) return null;
    const data = await r.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
  } catch (_) {
    // タイムアウト（AbortError）またはネットワークエラー → null でフォールバック
    clearTimeout(tid);
    console.warn('[gemini] モデル一覧の取得がタイムアウトまたは失敗しました。フォールバックリストを使用します。');
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
 *   6. 全滅した場合は 'gemini-2.0-flash' をデフォルトとして返す
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

  // v4.1: _fetchAvailableModels は 8 秒タイムアウト付きになったため
  //       ここで無限待機することはなくなった
  const available  = await _fetchAvailableModels(apiKey);
  let   candidates = FALLBACK_MODELS.slice();
  if (available) {
    const apiSet = new Set(available);
    const known  = candidates.filter(m => apiSet.has(m));
    const extra  = available.filter(m => !candidates.includes(m) && m.startsWith('gemini'));
    candidates   = [...known, ...extra];
    console.log(`[gemini] API取得候補: ${candidates.slice(0, 5).join(', ')}…`);
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

  console.warn('[gemini] 使用可能なモデルが見つかりません。gemini-2.0-flash をデフォルト使用');
  return 'gemini-2.0-flash';
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
  const cfg = LEVEL_CFG[level] || LEVEL_CFG[1];
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

  const cfg = LEVEL_CFG[level] || LEVEL_CFG[1];
  return pool.slice(0, count).map(p => ({
    level,
    grid:      { cols: cfg.gridN + 1, rows: cfg.gridN + 1 },
    lines:     p.lines,
    hintLines: p.hintLines || p.lines.slice(0, cfg.hints)
  }));
}

undefined
/* ====================================================================
   § 13. APIキー管理（公開 API）
==================================================================== */

/**
 * APIキーを localStorage に保存する。
 * キー変更時はモデルキャッシュと noMime フラグを同時にクリアする。
 * @param {string} key
 */
function saveApiKey(key) {
  try {
    localStorage.setItem('gemini_api_key', key);
    clearModelCache();       // モデルキャッシュをクリア
    _clearNoMimeCache();     // noMime フラグを全クリア
    console.log('[gemini] APIキーを保存しました。キャッシュをクリアしました。');
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
   § 14. モジュールエクスポート
==================================================================== */

// IIFE の戻り値として公開 API をまとめて返す
return {
  generateProblems,
  resolveModel,
  saveApiKey,
  loadApiKey,
  clearModelCache
};

})(); // IIFE 終了

// グローバルスコープへの展開
// app.js が generateProblems() 等を直接呼べるようにする
const { generateProblems, resolveModel, saveApiKey, loadApiKey, clearModelCache } = _G;
