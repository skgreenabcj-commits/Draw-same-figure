/**
 * gemini.js
 * Gemini API 連携 + 動的モデル選択（自動フォールバック付き）
 */

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const FALLBACK_MODEL_PRIORITY = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.0-pro'
];

const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

/* ============================================================
   モデル選択ロジック
   ============================================================ */

async function fetchAvailableModels(apiKey) {
  const res = await fetch(
    `${GEMINI_BASE_URL}/models?key=${encodeURIComponent(apiKey)}`,
    { method: 'GET' }
  );
  if (!res.ok) throw new Error(`モデル一覧取得失敗: ${res.status}`);

  const data = await res.json();
  const models = (data.models || [])
    .map(m => m.name.replace('models/', ''))
    .filter(name =>
      name.startsWith('gemini') &&
      !name.includes('embedding') &&
      !name.includes('vision') &&
      !name.includes('aqa')
    );

  console.log('[Gemini] 取得したモデル一覧:', models);
  return models;
}

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
    return res.ok || res.status === 429;
  } catch {
    return false;
  }
}

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

function saveCachedModel(modelName) {
  try {
    localStorage.setItem('gemini_selected_model', JSON.stringify({
      model:     modelName,
      timestamp: Date.now()
    }));
  } catch {}
}

async function resolveModel(apiKey) {
  const cached = loadCachedModel();
  if (cached) return cached;

  let candidates = [...FALLBACK_MODEL_PRIORITY];

  try {
    const available = await fetchAvailableModels(apiKey);
    const fromPriority = FALLBACK_MODEL_PRIORITY.filter(m => available.includes(m));
    const extra = available.filter(
      m => !FALLBACK_MODEL_PRIORITY.includes(m) &&
           (m.includes('flash') || m.includes('pro'))
    );
    candidates = [...fromPriority, ...extra];
    console.log('[Gemini] 使用候補モデル:', candidates);
  } catch (e) {
    console.warn('[Gemini] モデル一覧取得失敗、フォールバックリストを使用:', e.message);
  }

  for (const model of candidates) {
    console.log('[Gemini] テスト中:', model);
    const ok = await testModel(model, apiKey);
    if (ok) {
      console.log('[Gemini] 選択されたモデル:', model);
      saveCachedModel(model);
      return model;
    }
  }

  console.warn('[Gemini] 全モデルのテスト失敗。フォールバック:', FALLBACK_MODEL_PRIORITY[0]);
  return FALLBACK_MODEL_PRIORITY[0];
}

function clearModelCache() {
  try { localStorage.removeItem('gemini_selected_model'); } catch {}
}

/* ============================================================
   プロンプト生成
   ★ レベルごとの交差数制約を明示的に指定する
   ============================================================ */

/**
 * 2線分が内部で交差するかを判定するヘルパー（プロンプト説明用コメント）
 *
 * 交差数の仕様:
 *   Lv0: 最低1箇所・最大2箇所
 *   Lv1: 最低1箇所・最大3箇所
 *   Lv2: 最低3箇所・最大5箇所
 *   Lv3: 制限なし
 */
function buildPrompt(level, count) {

  const gridDesc = level <= 2
    ? `4x4 grid (integer coordinates: x from 0 to 3, y from 0 to 3)`
    : `5x5 grid (integer coordinates: x from 0 to 4, y from 0 to 4)`;

  const gridMax  = level <= 2 ? 3 : 4;
  const lineCount = level <= 2 ? '4' : '5 to 7';

  /* ---------- レベル別の交差数・複雑度の指示 ---------- */
  const crossingDef = `
=== HOW TO COUNT INTERSECTIONS ===
Two line segments INTERSECT when they cross each other at an interior point
(NOT at a shared endpoint). Count only these interior crossing points.
Example: segment A=(0,0)→(3,3) and segment B=(0,3)→(3,0) intersect at (1.5,1.5) → 1 intersection.
`;

  let crossingRule = '';
  let complexityRule = '';

  if (level === 0) {
    crossingRule = `
=== INTERSECTION COUNT RULE (STRICTLY ENFORCED) ===
- Minimum intersections: 1
- Maximum intersections: 2
- Count ALL pairs of line segments that cross at interior points.
- The total count across all pairs MUST be between 1 and 2 (inclusive).
`;
    complexityRule = `
=== COMPLEXITY ===
- Exactly 4 line segments per problem.
- Must include at least 1 DIAGONAL line (x1≠x2 AND y1≠y2).
- Simple shape: suitable for very young children (age 4-5).
- 3 lines will be shown as hints; the child draws only 1 line.
- The 1 line the child draws should be a DIAGONAL line (most educational).
`;
  } else if (level === 1) {
    crossingRule = `
=== INTERSECTION COUNT RULE (STRICTLY ENFORCED) ===
- Minimum intersections: 1
- Maximum intersections: 3
- Count ALL pairs of line segments that cross at interior points.
- The total count across all pairs MUST be between 1 and 3 (inclusive).
`;
    complexityRule = `
=== COMPLEXITY ===
- Exactly 4 line segments per problem.
- Must include at least 1 DIAGONAL line (x1≠x2 AND y1≠y2).
- Moderate shape: suitable for children age 5-6.
- 2 lines will be shown as hints; the child draws 2 lines.
`;
  } else if (level === 2) {
    crossingRule = `
=== INTERSECTION COUNT RULE (STRICTLY ENFORCED) ===
- Minimum intersections: 3
- Maximum intersections: 5
- Count ALL pairs of line segments that cross at interior points.
- The total count across all pairs MUST be between 3 and 5 (inclusive).
- To achieve 3+ intersections with 4 segments, you typically need:
    * Two diagonal lines crossing each other (1 intersection), PLUS
    * One or two additional lines (horizontal/vertical/diagonal)
      that each cross 1 or 2 of the existing lines.
  Example achieving 5: X-shape (1) + horizontal crossing both diagonals (2 more) 
                        + vertical crossing both diagonals (2 more) = 5 total.
`;
    complexityRule = `
=== COMPLEXITY ===
- Exactly 4 line segments per problem.
- Must include at least 2 DIAGONAL lines (x1≠x2 AND y1≠y2).
- Complex shape: suitable for children age 6-7.
- No hints shown; the child draws all 4 lines.
`;
  } else {
    crossingRule = `
=== INTERSECTION COUNT RULE ===
- No strict limit, but aim for 3 or more intersections for visual complexity.
`;
    complexityRule = `
=== COMPLEXITY ===
- 5 to 7 line segments per problem.
- Must include at least 3 DIAGONAL lines.
- Use the full 5x5 grid space.
- Complex shapes: stars, windmills, compound polygons encouraged.
`;
  }

  return `You are an expert designer of shape-drawing puzzles for elementary school children.
Generate exactly ${count} DIFFERENT problems for Level ${level}.

=== GRID ===
${gridDesc}

=== LINES PER PROBLEM ===
Exactly ${lineCount} straight line segments per problem.

${crossingDef}
${crossingRule}
${complexityRule}

=== STRICTLY FORBIDDEN (will be rejected) ===
- Simple rectangles or squares with zero intersections — BANNED
- All lines going only horizontally — BANNED
- All lines going only vertically — BANNED
- Shapes with zero diagonal lines — BANNED
- Duplicate lines (same two endpoints, regardless of order) — BANNED
- Lines where start == end (zero-length) — BANNED
- Problems whose intersection count is OUTSIDE the specified range — BANNED

=== SELF-CHECK BEFORE OUTPUT ===
For each problem you generate, you MUST verify:
1. Count every pair of segments and check for interior intersections.
2. Confirm the total intersection count is within the required range.
3. If not, redesign the problem until it passes.

=== OUTPUT FORMAT ===
Return a raw JSON array ONLY. No markdown, no explanation, no code fences.

[
  {
    "lines": [
      {"x1": 0, "y1": 0, "x2": 3, "y2": 3},
      {"x1": 3, "y1": 0, "x2": 0, "y2": 3},
      {"x1": 0, "y1": 1, "x2": 3, "y2": 1},
      {"x1": ${gridMax}, "y1": 0, "x2": ${gridMax}, "y2": 3}
    ]
  }
]

CRITICAL: Output ONLY the JSON array. Start with [ and end with ]. No other text.`;
}

/* ============================================================
   AIの回答を受け取った後にクライアント側でも交差数を検証する
   ============================================================ */

/**
 * 2線分が内部で交差するか判定（端点共有は交差としない）
 */
function segmentsIntersect(l1, l2) {
  const x1 = l1.x1, y1 = l1.y1, x2 = l1.x2, y2 = l1.y2;
  const x3 = l2.x1, y3 = l2.y1, x4 = l2.x2, y4 = l2.y2;

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return false; // 平行

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / denom;

  // 端点(0または1)を除く内部での交差のみカウント
  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/**
 * 線分リストの全ペアの交差数を数える
 */
function countIntersections(lines) {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (segmentsIntersect(lines[i], lines[j])) count++;
    }
  }
  return count;
}

/**
 * レベルの交差数仕様を満たすか検証する
 */
function validateIntersections(lines, level) {
  const count = countIntersections(lines);
  if (level === 0) return count >= 1 && count <= 2;
  if (level === 1) return count >= 1 && count <= 3;
  if (level === 2) return count >= 3 && count <= 5;
  return true; // Lv3 は制限なし
}

/* ============================================================
   公開: 問題生成
   ============================================================ */
async function generateProblems(level, count, apiKey) {
  if (!apiKey) throw new Error('APIキーが設定されていません');

  const modelName = await resolveModel(apiKey);
  console.log('[Gemini] 使用モデル:', modelName);

  const prompt = buildPrompt(level, count);
  const body   = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:     1.0,
      topP:            0.95,
      maxOutputTokens: 4096,
      thinkingConfig:  { thinkingBudget: 0 }
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

  /* ★ 正規化 → 交差数検証 → 失格問題は内蔵問題で補完 */
  const normalized = parsed
    .slice(0, count)
    .map(raw => normalizeProblem({ ...raw, grid: { cols: gridSize, rows: gridSize } }, level));

  const validated = normalized.map((prob, i) => {
    const ok = validateIntersections(prob.lines, level);
    if (!ok) {
      const crossCount = countIntersections(prob.lines);
      console.warn(
        `[Gemini] 問題${i + 1} 交差数不適合: ${crossCount}交差 (Lv${level}の仕様外) → 内蔵問題で補完`
      );
      // 内蔵問題からランダムに1問補完
      const fallback = getProblems(level);
      return fallback[0];
    }
    return prob;
  });

  return validated;
}

/* ============================================================
   APIキーの保存・読み込み
   ============================================================ */
function saveApiKey(key) {
  try {
    localStorage.setItem('gemini_api_key', key);
    clearModelCache();
  } catch {}
}

function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; } catch { return ''; }
}
