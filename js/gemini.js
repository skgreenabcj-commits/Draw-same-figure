'use strict';

/* =====================================================================
   gemini.js  v4.0
   -----------------------------------------------------------------------
   v3.0 からの主な変更点:
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
// キー: モデル名ごとのフラグを JSON オブジェクトとして1つのエントリに集約
const NO_MIME_CACHE_KEY = 'gemini_no_mime_v1';
const NO_MIME_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7日間（ミリ秒）
//
// 【TTL を 7 日間に設定した理由】
// Google は Gemini モデルの API サポート仕様をおおむね数週間〜数ヶ月単位で
// 更新する。7 日ごとに再挑戦することで、モデルが responseMimeType に対応
// した際に自動的に高品質モードへ復帰できる。
// 毎回テキストモードで送信するコストは低いため、積極的な再挑戦が適切。

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
 * d1〜d4 は外積（cross product）の符号で交差方向を判定する。
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
   § 3. 正規化（AI 生出力 → 問題オブジェクト）
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
   § 4. テキスト抽出パーサー（responseMimeType 非対応モデル向け）
==================================================================== */

/**
 * Gemini がテキストモードで返したレスポンス文字列から
 * JSON 配列を抽出して返す。
 *
 * 対処するパターン:
 *   A. JSON がオブジェクトラッパーに包まれている
 *      例: {"problems": [...]} → 内側の配列を取り出す
 *   B. 複数の JSON ブロックが混在している
 *      例: マークダウンコードブロック内 ```json [...] ```
 *      → 最も長い（= 最も情報量の多い）配列ブロックを選ぶ
 *   C. 座標値が文字列で返る → _normalise の clamp で吸収
 *   D. 交差数が仕様外   → _countCross + LEVEL_CFG でフィルタ
 *
 * @param {string} text - API レスポンスのテキスト部分
 * @returns {Array|null} パース済み配列、取得できなければ null
 */
function _extractJsonArray(text) {
  if (!text) return null;

  // ── ステップ1: マークダウンコードブロックを除去 ──────────────────
  // ```json ... ``` または ``` ... ``` 形式を平文に展開する
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();

  // ── ステップ2: テキスト中の全 '[...]' ブロックを収集 ────────────
  // 単純な正規表現では入れ子の '[' に対応できないため、
  // 文字を1つずつ追って対応する ']' を探すスタックベースの抽出を行う
  const candidates = _extractAllArrayStrings(stripped);

  // ── ステップ3: 最も長い配列文字列を優先してパース試行 ────────────
  // 長さでソート（降順）して先頭から試す
  // 長い方が「全問題を含む配列」である可能性が高い
  candidates.sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 各要素が lines キーを持つか確認（問題配列かチェック）
        if (parsed.every(item => typeof item === 'object' && item !== null)) {
          return parsed;
        }
      }
    } catch (_) {
      // パース失敗 → 次の候補へ
    }
  }

  // ── ステップ4: パターンA対応 ─────────────────────────────────────
  // 配列が取れなかった場合、オブジェクトラッパーを試みる
  // 例: {"problems": [...], "count": 5} → problems の値を取り出す
  const objCandidates = _extractAllObjectStrings(stripped);
  objCandidates.sort((a, b) => b.length - a.length);

  for (const candidate of objCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // オブジェクトの値の中で配列を探す
        for (const val of Object.values(parsed)) {
          if (Array.isArray(val) && val.length > 0 &&
              val.every(item => typeof item === 'object' && item !== null)) {
            console.log('[gemini] パターンA検出: オブジェクトラッパーをアンラップしました');
            return val;
          }
        }
      }
    } catch (_) {
      // パース失敗 → 次の候補へ
    }
  }

  // ── ステップ5: パターンB対応 ─────────────────────────────────────
  // 改行区切りの個別 JSON オブジェクトを配列として収集する
  // 例: {"lines":[...]}\n{"lines":[...]} → [{lines:[...]}, {lines:[...]}]
  const lines = stripped.split('\n');
  const lineObjects = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && 'lines' in obj) {
          lineObjects.push(obj);
        }
      } catch (_) { /* 無視 */ }
    }
  }
  if (lineObjects.length > 0) {
    console.log(`[gemini] パターンB検出: 改行区切りオブジェクト ${lineObjects.length} 件を収集しました`);
    return lineObjects;
  }

  // すべての試みが失敗
  console.warn('[gemini] テキストから JSON 配列を抽出できませんでした');
  return null;
}

/**
 * 文字列中のすべての '[...]' ブロックをスタックベースで抽出する。
 * 入れ子になった配列（座標の [x,y] 等）も正確に対応できる。
 *
 * @param {string} text
 * @returns {string[]} 抽出した '[...]' 文字列の配列
 */
function _extractAllArrayStrings(text) {
  const results = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      if (depth === 0) start = i; // 最外の '[' の位置を記録
      depth++;
    } else if (text[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(text.slice(start, i + 1)); // 対応する ']' まで切り出す
        start = -1;
      }
    }
  }
  return results;
}

/**
 * 文字列中のすべての '{...}' ブロックをスタックベースで抽出する。
 * パターンA（オブジェクトラッパー）の検出に使用する。
 *
 * @param {string} text
 * @returns {string[]} 抽出した '{...}' 文字列の配列
 */
function _extractAllObjectStrings(text) {
  const results = [];
  let depth = 0;
  let start = -1;

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
   § 5. responseMimeType 非対応フラグのキャッシュ管理
==================================================================== */

/**
 * 指定モデルが responseMimeType 非対応としてキャッシュされているか確認する。
 *
 * キャッシュの構造（localStorage の NO_MIME_CACHE_KEY に保存）:
 *   {
 *     "gemini-1.0-pro": { "ts": 1234567890000 },
 *     "gemini-1.5-pro": { "ts": 1234567890000 }
 *   }
 *
 * TTL（NO_MIME_CACHE_TTL = 7日）を超えたエントリは自動的に無効と見なし、
 * 次回の送信で responseMimeType を再挑戦させる。
 *
 * @param {string} model - モデル名
 * @returns {boolean} キャッシュが有効な非対応フラグが存在すれば true
 */
function _isNoMimeCached(model) {
  try {
    const raw = localStorage.getItem(NO_MIME_CACHE_KEY);
    if (!raw) return false;

    const cache = JSON.parse(raw);
    const entry = cache[model];
    if (!entry) return false;

    // TTL チェック: 7日以内なら有効、超えていれば期限切れ
    const isValid = (Date.now() - entry.ts) < NO_MIME_CACHE_TTL;
    if (!isValid) {
      // 期限切れエントリを削除して保存（他のモデルのエントリは保持）
      delete cache[model];
      localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));
      console.log(`[gemini] responseMimeType 非対応フラグ期限切れ（${model}）→ 再挑戦します`);
    }
    return isValid;
  } catch (_) {
    return false;
  }
}

/**
 * 指定モデルを responseMimeType 非対応としてキャッシュに記録する。
 * 既存の他モデルのエントリは保持し、対象モデルのエントリのみ追加・更新する。
 *
 * @param {string} model - モデル名
 */
function _setNoMimeCache(model) {
  try {
    // 既存キャッシュを読み込む（なければ空オブジェクトで初期化）
    const raw   = localStorage.getItem(NO_MIME_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};

    // 対象モデルのエントリを追加・更新
    cache[model] = { ts: Date.now() };
    localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));

    // 次回の再挑戦予定日時をコンソールに表示（デバッグ用）
    const retryDate = new Date(Date.now() + NO_MIME_CACHE_TTL).toLocaleDateString('ja-JP');
    console.log(
      `[gemini] ${model} を responseMimeType 非対応としてキャッシュしました。` +
      `${retryDate} 以降に自動再挑戦します。`
    );
  } catch (_) { /* localStorage 書き込みエラーは無視 */ }
}

/**
 * 指定モデルの responseMimeType 非対応フラグをクリアする。
 * APIキー変更時・手動リセット時に呼ばれる。
 * 引数なしで呼ぶと全モデルのフラグを一括クリアする。
 *
 * @param {string} [model] - クリアするモデル名（省略時は全クリア）
 */
function _clearNoMimeCache(model) {
  try {
    if (!model) {
      // 引数なし: 全エントリを削除
      localStorage.removeItem(NO_MIME_CACHE_KEY);
      console.log('[gemini] responseMimeType 非対応フラグを全クリアしました');
      return;
    }
    // 特定モデルのみ削除
    const raw = localStorage.getItem(NO_MIME_CACHE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    delete cache[model];
    localStorage.setItem(NO_MIME_CACHE_KEY, JSON.stringify(cache));
  } catch (_) { /* 無視 */ }
}

/* ====================================================================
   § 6. モデルキャッシュ管理（既存機能）
==================================================================== */

/**
 * localStorage からモデルキャッシュを読み込む。
 * TTL（24時間）を超えている場合は null を返す。
 *
 * @returns {string|null} キャッシュ済みモデル名、または null
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
 * 選択されたモデル名をタイムスタンプ付きで localStorage に保存する。
 *
 * @param {string} model
 */
function _saveModel(model) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ model, ts: Date.now() }));
  } catch (_) {}
}

/**
 * モデルキャッシュをクリアする。
 * APIキー変更時・認証エラー時に呼ばれる。
 * 公開 API として外部（app.js）からも呼び出せる。
 */
function clearModelCache() {
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch (_) {}
}

/* ====================================================================
   § 7. モデル解決（プローブ + キャッシュ）
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
          contents:       [{ parts: [{ text: 'Reply with the single word: ready' }] }],
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
 * 取得に失敗した場合は null を返す。
 *
 * @param {string} apiKey
 * @returns {Promise<string[]|null>}
 */
async function _fetchAvailableModels(apiKey) {
  try {
    const r = await fetch(`${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) return null;
    const data = await r.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
  } catch (_) { return null; }
}

/**
 * 最適なモデルを以下の優先順位で解決する:
 *   1. localStorage キャッシュにヒットすればそれを返す（24時間有効）
 *   2. PREFERRED_MODEL をプローブ → 成功すれば採用
 *   3. API からモデル一覧を取得して既知リストと照合
 *   4. 上位 3 モデルを並列プローブ → 最速で成功したものを採用
 *   5. 残りを直列プローブ
 *   6. 全滅した場合は 'gemini-2.0-flash' をデフォルトとして返す
 *
 * @param {string} apiKey
 * @returns {Promise<string>} 使用するモデル名
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
   § 8. プロンプト生成
==================================================================== */

/**
 * Gemini に送るプロンプト文字列を組み立てる。
 * レベル別の線分数・グリッドサイズ・交差数制約・自己チェック手順を含む。
 *
 * @param {number} level - レベル番号
 * @param {number} count - 生成する問題数
 * @returns {string}
 */
function _buildPrompt(level, count) {
  const cfg      = LEVEL_CFG[level] || LEVEL_CFG[1];
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
   § 9. フォールバック問題バンク
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
    // hintLines は線分オブジェクトの配列（数値インデックスではない）
    hintLines: p.hintLines || p.lines.slice(0, cfg.hints)
  }));
}

/* ====================================================================
   § 10. API 送信コア（responseMimeType 自動切替ロジック）
==================================================================== */

/**
 * 単一の generateContent リクエストを送信し、
 * パース済みの問題候補配列を返す。
 *
 * 【responseMimeType 自動切替の仕組み】
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  _isNoMimeCached(model) ?                               │
 * │    Yes → テキストモードで送信（再挑戦は 7 日後）          │
 * │    No  → responseMimeType 付きで送信                    │
 * │             ↓ HTTP 400?                                 │
 * │             Yes → _setNoMimeCache(model) でフラグ保存   │
 * │                   → テキストモードで即再送              │
 * │                   → RPD 消費は 1 回分だけ追加で発生     │
 * │             No  → 通常処理                              │
 * └─────────────────────────────────────────────────────────┘
 *
 * 「即再送」は同じ試行カウントを消費しない（attempt はインクリメントしない）
 * ため、MAX_ATTEMPTS のリトライ枠を無駄にしない。
 *
 * @param {string}  model      - 使用するモデル名
 * @param {string}  apiKey     - Gemini API キー
 * @param {string}  prompt     - 送信プロンプト
 * @param {boolean} forcePlain - true の場合は responseMimeType を付けない
 * @returns {Promise<{raw: Array|null, status: number}>}
 *   raw: パース済み配列（失敗時 null）
 *   status: HTTP ステータスコード（fetch 失敗時は 0）
 */
async function _callApi(model, apiKey, prompt, forcePlain = false) {
  // ── generationConfig の組み立て ──────────────────────────────────
  const generationConfig = {
    temperature:     0.7,   // 出力の多様性（0=決定論的, 1=最大多様性）
    maxOutputTokens: 2048   // 最大出力トークン数
  };

  // responseMimeType を付けるかどうかの判断:
  //   forcePlain=true    → 付けない（400 後の即再送）
  //   noMime キャッシュあり → 付けない（過去に非対応が判明済み）
  //   それ以外           → 付ける（JSON モードを試みる）
  const useJsonMode = !forcePlain && !_isNoMimeCached(model);
  if (useJsonMode) {
    generationConfig.responseMimeType = 'application/json';
  }

  console.log(
    `[gemini] 送信モード: ${useJsonMode ? 'JSON (responseMimeType)' : 'テキスト (抽出+パース)'}`
  );

  let resp;
  try {
    resp = await fetch(
      `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig
        })
      }
    );
  } catch (e) {
    // ネットワークエラー・タイムアウト等
    console.error('[gemini] fetch 失敗:', e.message);
    return { raw: null, status: 0 };
  }

  // ── HTTP 400: responseMimeType 非対応の可能性 ────────────────────
  if (resp.status === 400 && useJsonMode) {
    console.warn(
      `[gemini] HTTP 400 を受信（${model}）。` +
      'responseMimeType 非対応の可能性があります。テキストモードで即再送します。'
    );
    // 非対応フラグをキャッシュ（7日間有効）
    _setNoMimeCache(model);
    // テキストモードで即再送（forcePlain=true）
    // ★ この再帰呼び出しは forcePlain=true のため無限ループしない
    return _callApi(model, apiKey, prompt, true);
  }

  // ── その他のエラー ───────────────────────────────────────────────
  if (!resp.ok) {
    console.warn(`[gemini] HTTP ${resp.status}`);
    return { raw: null, status: resp.status };
  }

  // ── レスポンスのパース ───────────────────────────────────────────
  let raw = null;
  try {
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (useJsonMode && text) {
      // JSON モードの場合: text は純粋な JSON 文字列のはずなので直接パース
      // 万が一マークダウンが混入していても _extractJsonArray でフォールバック
      try {
        const parsed = JSON.parse(text);
        raw = Array.isArray(parsed) ? parsed : null;
        if (!raw) {
          // オブジェクトラッパー等への対処
          console.log('[gemini] JSON モードでもパース結果が配列でないため抽出パーサーで再試行');
          raw = _extractJsonArray(text);
        }
      } catch (_) {
        // JSON パース失敗 → テキスト抽出パーサーにフォールバック
        console.log('[gemini] JSON モードのパース失敗 → テキスト抽出パーサーを使用');
        raw = _extractJsonArray(text);
      }
    } else {
      // テキストモードの場合: 抽出パーサーを使用
      raw = _extractJsonArray(text);
    }
  } catch (e) {
    console.error('[gemini] レスポンス処理エラー:', e);
  }

  return { raw, status: resp.status };
}

/* ====================================================================
   § 11. メイン問題生成関数
==================================================================== */

/**
 * Gemini API を使って指定レベルの問題を count 問生成して返す。
 *
 * 処理フロー:
 *   1. APIキー未設定 → フォールバック即返し
 *   2. resolveModel でモデルを決定
 *   3. MAX_ATTEMPTS 回ループ:
 *      a. _callApi でリクエスト送信（responseMimeType 自動切替含む）
 *      b. 429 → 3秒待機して続行
 *      c. 403 → キャッシュクリアして中断
 *      d. 取得した候補を _normalise + _countCross で検証・収集
 *   4. 不足分は _getFallback で補填
 *
 * @param {number} level  - レベル番号 (0–3)
 * @param {number} count  - 生成する問題数
 * @param {string} apiKey - Gemini API キー
 * @returns {Promise<Array>} 検証済み問題オブジェクトの配列
 */
async function generateProblems(level, count, apiKey) {
  // APIキー未設定: 即フォールバック
  if (!apiKey) {
    console.warn('[gemini] APIキー未設定 – フォールバックバンクを使用');
    return _getFallback(level, count);
  }

  // モデルの解決
  let model;
  try {
    model = await resolveModel(apiKey);
  } catch (e) {
    console.error('[gemini] resolveModel 失敗:', e);
    return _getFallback(level, count);
  }

  const MAX_ATTEMPTS = 5;  // 最大試行回数
  const collected    = []; // 検証済み問題の蓄積配列

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && collected.length < count; attempt++) {
    const need   = count - collected.length;
    const prompt = _buildPrompt(level, need);

    console.log(`[gemini] 試行 ${attempt}/${MAX_ATTEMPTS} | モデル=${model} | 必要数=${need}`);

    // ── API 送信（responseMimeType 自動切替ロジックは _callApi 内で処理）──
    const { raw, status } = await _callApi(model, apiKey, prompt);

    // ── ステータス別の処理 ──────────────────────────────────────────
    if (status === 429) {
      // レート制限: 3 秒待機してリトライ
      console.warn('[gemini] レート制限中（429）。3秒後にリトライ…');
      await new Promise(r => setTimeout(r, 3000));
      attempt--; // この試行をカウントしない（ペナルティなし）
      continue;
    }
    if (status === 403) {
      // 認証エラー: モデルキャッシュをクリアして中断
      console.error('[gemini] 認証エラー（403）– モデルキャッシュをクリアして中断');
      clearModelCache();
      break;
    }
    // 注: status === 400 は _callApi 内でテキストモード再送済みのため
    //     ここに到達する 400 は「テキストモードでも 400」の場合のみ
    if (status === 400) {
      console.error('[gemini] テキストモードでも HTTP 400 – モデルキャッシュをクリアして中断');
      clearModelCache();
      break;
    }
    if (!raw) {
      // パース失敗・空レスポンス: 次の試行へ
      console.warn('[gemini] 有効な問題データを取得できませんでした。次の試行へ…');
      continue;
    }

    // ── 候補問題の検証・収集 ────────────────────────────────────────
    for (const candidate of raw) {
      if (collected.length >= count) break;

      // 正規化（座標クランプ・長さゼロ除去・hintLines 付与）
      const p = _normalise(candidate, level);
      if (!p) {
        console.log('[gemini] 正規化失敗（線分数不正 or 長さゼロ線分あり）→ スキップ');
        continue;
      }

      // 交差数チェック
      const n         = _countCross(p.lines);
      const { lo, hi } = LEVEL_CFG[level] || LEVEL_CFG[1];
      if (n < lo || n > hi) {
        console.log(`[gemini] 交差数違反: ${n} ∉ [${lo}, ${hi}] → スキップ`);
        continue;
      }

      console.log(`[gemini] 採用: 交差数=${n} ✓`);
      collected.push(p);
    }
  }

  // ── 不足分をフォールバックで補填 ────────────────────────────────
  if (collected.length < count) {
    console.warn(
      `[gemini] 有効問題が ${collected.length}/${count} のみ – フォールバックで補填`
    );
    const pad = _getFallback(level, count - collected.length);
    collected.push(...pad);
  }

  return collected.slice(0, count);
}

/* ====================================================================
   § 12. APIキー管理ヘルパー
==================================================================== */

/**
 * Gemini API キーを localStorage に保存する。
 * キーが変更された場合は古いモデル情報が無効になるため、
 * モデルキャッシュと responseMimeType 非対応フラグを両方クリアする。
 *
 * @param {string} key - 保存する API キー（空文字でクリア）
 */
function saveApiKey(key) {
  try { localStorage.setItem('gemini_api_key', key); } catch (_) {}
  // APIキー変更時はすべてのキャッシュをリセット
  clearModelCache();
  _clearNoMimeCache(); // 全モデルの非対応フラグをクリア
}

/**
 * localStorage から Gemini API キーを読み込む。
 * 未設定の場合は空文字列を返す。
 *
 * @returns {string}
 */
function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; } catch (_) { return ''; }
}

/* ====================================================================
   § 13. 公開インターフェース
==================================================================== */

/**
 * 外部から呼び出せる関数・定数を列挙して返す。
 * _G.xxx の形式で参照するか、ファイル末尾で再エクスポートして
 * xxx() の形で直接呼び出せるようにする。
 *
 * clearModelCache は app.js から呼ばれる可能性があるため公開する。
 * その他のキャッシュ管理関数（_setNoMimeCache 等）は内部使用のみ。
 */
return {
  generateProblems,
  resolveModel,
  saveApiKey,
  loadApiKey,
  clearModelCache
};

})(); // _G IIFE 終了

/* ====================================================================
   モジュールレベルへの再エクスポート
   _G.xxx の形式ではなく直接 xxx() で呼べるようにフラットに展開する
==================================================================== */
const generateProblems = _G.generateProblems;
const resolveModel     = _G.resolveModel;
const saveApiKey       = _G.saveApiKey;
const loadApiKey       = _G.loadApiKey;
const clearModelCache  = _G.clearModelCache;
