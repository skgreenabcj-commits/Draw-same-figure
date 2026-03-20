/**
 * gemini.js
 * Gemini API 連携 + 動的モデル選択（自動フォールバック付き）
 *
 * 公開関数:
 *   generateProblems(level, count, apiKey) → Promise<Problem[]>
 *   saveApiKey(key)
 *   loadApiKey()
 */

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/* ============================================================
   モデル優先順位リスト（フォールバック用ハードコード）
   Free tier で使える可能性が高い順に並べる
   ============================================================ */
const FALLBACK_MODEL_PRIORITY = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.0-pro'
];

/* キャッシュの有効期限（ミリ秒） — 24時間 */
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

/* ============================================================
   モデル選択ロジック
   ============================================================ */

/**
 * 利用可能なモデル一覧を API から取得する
 * @returns {Promise<string[]>} モデル名の配列（例: ['gemini-2.0-flash', ...]）
 */
async function fetchAvailableModels(apiKey) {
  const res = await fetch(
    `${GEMINI_BASE_URL}/models?key=${encodeURIComponent(apiKey)}`,
    { method: 'GET' }
  );
  if (!res.ok) throw new Error(`モデル一覧取得失敗: ${res.status}`);

  const data = await res.json();
  const models = (data.models || [])
    .map(m => m.name.replace('models/', ''))          // "models/gemini-xx" → "gemini-xx"
    .filter(name =>
      name.startsWith('gemini') &&                     // Gemini 系のみ
      !name.includes('embedding') &&                   // embedding モデルを除外
      !name.includes('vision') &&                      // vision 専用を除外
      !name.includes('aqa')                            // AQA モデルを除外
    );

  console.log('[Gemini] 取得したモデル一覧:', models);
  return models;
}

/**
 * モデルが実際に generateContent を受け付けるか確認する
 * 最小限のリクエストで疎通テストを行う
 * @returns {Promise<boolean>}
 */
async function testModel(modelName, apiKey) {
  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 8 }
        })
      }
    );
    // 200 系ならOK、429（レート超過）は使えるが混んでいる → OKとみなす
    return res.ok || res.status === 429;
  } catch {
    return false;
  }
}

/**
 * キャッシュからモデル名を読み込む
 * TTL 切れの場合は null を返す
 * @returns {string|null}
 */
function loadCachedModel() {
  try {
    const raw = localStorage.getItem('gemini_selected_model');
    if (!raw) return null;
    const { model, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > MODEL_CACHE_TTL) {
      localStorage.removeItem('gemini_selected_model');
      return null;
    }
    console.log('[Gemini] キャッシュ済みモデルを使用:', model);
    return model;
  } catch {
    return null;
  }
}

/**
 * 選択されたモデル名をキャッシュに保存する
 */
function saveCachedModel(modelName) {
  try {
    localStorage.setItem('gemini_selected_model', JSON.stringify({
      model:     modelName,
      timestamp: Date.now()
    }));
  } catch {}
}

/**
 * 使用するモデルを動的に決定する
 *
 * 手順:
 *  1. キャッシュが有効なら即返す
 *  2. API からモデル一覧を取得
 *  3. 優先度リストと突き合わせて候補を絞る
 *  4. 候補を順番にテストして最初に成功したものを返す
 *  5. 全て失敗したらフォールバックリストの先頭を返す
 *
 * @returns {Promise<string>} 使用するモデル名
 */
async function resolveModel(apiKey) {
  // 1. キャッシュ確認
  const cached = loadCachedModel();
  if (cached) return cached;

  let candidates = [...FALLBACK_MODEL_PRIORITY];

  // 2. API からモデル一覧を取得して候補を絞る
  try {
    const available = await fetchAvailableModels(apiKey);

    // 優先リストに含まれているものを優先順で並べる
    const fromPriority = FALLBACK_MODEL_PRIORITY.filter(m => available.includes(m));

    // 優先リストにないが API で取得できた gemini-flash/pro 系も後ろに追加
    const extra = available.filter(
      m => !FALLBACK_MODEL_PRIORITY.includes(m) &&
           (m.includes('flash') || m.includes('pro'))
    );

    candidates = [...fromPriority, ...extra];
    console.log('[Gemini] 使用候補モデル:', candidates);
  } catch (e) {
    console.warn('[Gemini] モデル一覧取得失敗、フォールバックリストを使用:', e.message);
  }

  // 3. 候補を順番にテストする
  for (const model of candidates) {
    console.log('[Gemini] テスト中:', model);
    const ok = await testModel(model, apiKey);
    if (ok) {
      console.log('[Gemini] 選択されたモデル:', model);
      saveCachedModel(model);
      return model;
    }
  }

  // 4. 全て失敗 → フォールバック先頭をそのまま使う（エラーは呼び出し元で処理）
  console.warn('[Gemini] 全モデルのテスト失敗。フォールバック:', FALLBACK_MODEL_PRIORITY[0]);
  return FALLBACK_MODEL_PRIORITY[0];
}

/* ============================================================
   モデルキャッシュ強制クリア（外部から呼べる公開関数）
   APIキーを変更した際などに呼ぶ
   ============================================================ */
function clearModelCache() {
  try { localStorage.removeItem('gemini_selected_model'); } catch {}
}

/* ============================================================
   プロンプト生成
   ============================================================ */
function buildPrompt(level, count) {
  const gridMax  = level <= 2 ? 3 : 4;
  const gridDesc = level <= 2
    ? `4x4 grid (integer coordinates: x from 0 to 3, y from 0 to 3)`
    : `5x5 grid (integer coordinates: x from 0 to 4, y from 0 to 4)`;
  const lineCount = level <= 2 ? '4' : '5 to 7';
  const complexity = level === 1
    ? `- Must include at least 1 DIAGONAL line (x1≠x2 AND y1≠y2)
- Must change direction at least once (not all lines going the same way)
- Level 1 hint: 2 of the lines will be pre-drawn for the student`
    : level === 2
    ? `- Must include at least 2 DIAGONAL lines (x1≠x2 AND y1≠y2)
- Must include at least 1 intersection (two lines crossing each other)
- Shapes should feel like letters, arrows, or irregular polygons`
    : `- Must include at least 3 DIAGONAL lines
- Must include at least 2 intersections (lines crossing)
- Use the full 5x5 grid space — spread lines across the grid
- Complex shapes like stars, windmills, compound polygons with internal lines are encouraged`;

  return `You are an expert designer of shape-drawing puzzles for elementary school children.
Generate exactly ${count} DIFFERENT problems for Level ${level}.

=== GRID ===
${gridDesc}

=== LINES PER PROBLEM ===
Exactly ${lineCount} straight line segments per problem.

=== COMPLEXITY REQUIREMENTS (STRICTLY ENFORCED) ===
${complexity}

=== STRICTLY FORBIDDEN (will be rejected) ===
- Simple rectangles or squares (all 4 sides of a box) — BANNED
- All lines going only horizontally (same y direction) — BANNED
- All lines going only vertically (same x direction) — BANNED  
- Shapes with zero diagonal lines — BANNED
- Duplicate lines (same two endpoints, regardless of order) — BANNED
- Lines where start == end (zero-length) — BANNED

=== ALLOWED / ENCOURAGED ===
- Diagonal lines going in ANY direction (e.g. (0,0)→(2,3))
- Lines that cross/intersect other lines
- Open shapes: L, T, Z, K, W, N, X, Y, arrow, lightning bolt, star skeleton
- Shapes that use most of the grid space

=== OUTPUT FORMAT ===
Return a raw JSON array ONLY. No markdown, no explanation, no code fences.

[
  {
    "lines": [
      {"x1": 0, "y1": 0, "x2": 3, "y2": 2},
      {"x1": 3, "y1": 2, "x2": 1, "y2": 3},
      {"x1": 0, "y1": 0, "x2": 3, "y2": 3},
      {"x1": 0, "y1": 1, "x2": ${gridMax}, "y2": 1}
    ]
  }
]

CRITICAL: Output ONLY the JSON array. Start with [ and end with ]. No other text.`;
}

/* ============================================================
   公開: 問題生成
   ============================================================ */
async function generateProblems(level, count, apiKey) {
  if (!apiKey) throw new Error('APIキーが設定されていません');

  // モデルを動的に解決する
  const modelName = await resolveModel(apiKey);
  console.log('[Gemini] 使用モデル:', modelName);

  const prompt = buildPrompt(level, count);
  const body   = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:    1.0,
      topP:           0.95,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  const res = await fetch(
    `${GEMINI_BASE_URL}/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    }
  );

  // エラー時はキャッシュを消して次回再選択できるようにする
  if (!res.ok) {
    clearModelCache();

    let errMsg = `Gemini API エラー: ${res.status}`;
    try {
      const errJson = await res.json();
      const detail  = errJson?.error?.message || JSON.stringify(errJson);
      errMsg += `\n${detail}`;
      if (res.status === 429) errMsg = 'APIのリクエスト上限に達しました（429）。\nしばらく待ってから再試行してください。';
      if (res.status === 400) errMsg = `APIキーまたはモデル指定が無効です（400）。\n${detail}`;
      if (res.status === 403) errMsg = 'APIキーに権限がありません（403）。\nGemini APIが有効か確認してください。';
    } catch {}
    throw new Error(errMsg);
  }

  const data = await res.json();
  console.log('[Gemini] raw response (先頭500文字):', JSON.stringify(data).slice(0, 500));

  // Thinking モデルは parts が複数になるため、thought パートを除外して結合
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text  = parts
    .filter(p => p.text && !p.thought)
    .map(p => p.text)
    .join('')
    .trim();

  if (!text) {
    console.error('[Gemini] text パートが空:', JSON.stringify(data));
    throw new Error('AIから有効な回答が得られませんでした。再試行してください。');
  }

  // JSON を抽出（コードブロック・余分テキストを除去）
  let parsed;
  try {
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end   = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('JSON配列が見つかりません');
    cleaned = cleaned.slice(start, end + 1);
    parsed  = JSON.parse(cleaned);
  } catch (e) {
    console.error('[Gemini] パース失敗 raw text:', text);
    throw new Error(`AIの回答をパースできませんでした: ${e.message}`);
  }

  if (!Array.isArray(parsed)) throw new Error('AI回答が配列ではありません');

  const gridSize = level === 3 ? 5 : 4;
  return parsed.slice(0, count).map(raw =>
    normalizeProblem({ ...raw, grid: { cols: gridSize, rows: gridSize } }, level)
  );
}

/* ============================================================
   APIキーの保存・読み込み
   ★ キー変更時はモデルキャッシュもリセットする
   ============================================================ */
function saveApiKey(key) {
  try {
    localStorage.setItem('gemini_api_key', key);
    clearModelCache(); // キー変更時はモデルキャッシュをリセット
  } catch {}
}

function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; } catch { return ''; }
}
