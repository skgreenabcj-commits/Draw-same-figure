/**
 * gemini.js
 * Gemini API を使った問題の自動生成
 *
 * 公開関数:
 *   generateProblems(level, count, apiKey) → Promise<Problem[]>
 */

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

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

  const prompt = buildPrompt(level, count);

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1.0,
      topP: 0.95,
      maxOutputTokens: 4096,
      // Thinking を無効化してシンプルなテキスト出力にする
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  const res = await fetch(`${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let errMsg = `Gemini API エラー: ${res.status}`;
    try {
      const errJson = await res.json();
      const detail = errJson?.error?.message || JSON.stringify(errJson);
      errMsg += `\n${detail}`;
      if (res.status === 429) errMsg = 'APIのリクエスト上限に達しました（429）。\nしばらく待ってから再試行してください。';
      if (res.status === 400) errMsg = `APIキーまたはモデル指定が無効です（400）。\n${detail}`;
      if (res.status === 403) errMsg = 'APIキーに権限がありません（403）。\nGemini APIが有効か確認してください。';
    } catch(_) {
      errMsg += ' (詳細取得失敗)';
    }
    throw new Error(errMsg);
  }

  const data = await res.json();
  console.log('Gemini raw response:', JSON.stringify(data).slice(0, 500));

  // Thinking モデルは parts が複数になる場合があるため全 text パートを結合
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter(p => p.text && !p.thought)   // thought パートを除外
    .map(p => p.text)
    .join('')
    .trim();

  if (!text) {
    console.error('Gemini: text パートが空です', JSON.stringify(data));
    throw new Error('AIから有効な回答が得られませんでした。再試行してください。');
  }

  // JSONを抽出（コードブロック・余分なテキストを除去）
  let parsed;
  try {
    // ```json ... ``` や ``` ... ``` を除去
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    // 先頭の [ から末尾の ] までを抽出
    const start = cleaned.indexOf('[');
    const end   = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('JSON配列が見つかりません');
    cleaned = cleaned.slice(start, end + 1);
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('Gemini レスポンスパース失敗 raw text:', text);
    throw new Error(`AIの回答をパースできませんでした: ${e.message}`);
  }

  if (!Array.isArray(parsed)) throw new Error('AI回答が配列ではありません');

  const gridSize = level === 3 ? 5 : 4;

  // 正規化
  return parsed.slice(0, count).map((raw, i) => normalizeProblem({
    ...raw,
    grid: { cols: gridSize, rows: gridSize }
  }, level));
}

/* ============================================================
   APIキーの保存・読み込み
   ============================================================ */
function saveApiKey(key) {
  try { localStorage.setItem('gemini_api_key', key); } catch(e) {}
}

function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; } catch(e) { return ''; }
}
