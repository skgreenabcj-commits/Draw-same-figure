'use strict';

/* =====================================================================
   gemini.js  – Gemini API 連携 + モデル自動選択  v1.3
   交差数制限: Lv0: 1–2 / Lv1: 1–3 / Lv2: 3–5 / Lv3: 制限なし
===================================================================== */

const GEMINI_BASE_URL      = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODEL_PRIORITY = [
  'gemini-2.5-flash','gemini-2.0-flash','gemini-2.0-flash-lite',
  'gemini-1.5-flash','gemini-1.5-flash-8b','gemini-1.5-pro','gemini-1.0-pro'
];
const MODEL_CACHE_KEY = 'gemini_model_cache';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// ─── モデル自動選択 ───────────────────────────────────────────────────
async function fetchAvailableModels(apiKey) {
  const res = await fetch(`${GEMINI_BASE_URL}/models?key=${apiKey}`);
  if (!res.ok) throw new Error('models fetch failed');
  const data = await res.json();
  return (data.models || [])
    .map(m => m.name.replace('models/', ''))
    .filter(n =>
      n.startsWith('gemini') &&
      !n.includes('embedding') &&
      !n.includes('vision') &&
      !n.includes('aqa')
    );
}

async function testModel(modelName, apiKey) {
  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/models/${modelName}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] })
      }
    );
    return res.status === 200 || res.status === 429;
  } catch { return false; }
}

function loadCachedModel() {
  try {
    const c = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || 'null');
    if (c && Date.now() - c.ts < MODEL_CACHE_TTL) return c.model;
  } catch {}
  return null;
}

function saveCachedModel(model) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ model, ts: Date.now() }));
  } catch {}
}

function clearModelCache() {
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch {}
}

async function resolveModel(apiKey) {
  const cached = loadCachedModel();
  if (cached) return cached;

  let candidates = FALLBACK_MODEL_PRIORITY.slice();
  try {
    const available = await fetchAvailableModels(apiKey);
    candidates = [
      ...FALLBACK_MODEL_PRIORITY.filter(m => available.includes(m)),
      ...available.filter(m => !FALLBACK_MODEL_PRIORITY.includes(m)),
    ];
  } catch {}

  for (const m of candidates) {
    if (await testModel(m, apiKey)) {
      saveCachedModel(m);
      return m;
    }
  }
  return FALLBACK_MODEL_PRIORITY[0];
}

// ─── 交差判定（端点共有を除く厳密内部交差） ──────────────────────────
function _onSeg(px, py, ax, ay, bx, by) {
  return Math.min(ax,bx) <= px && px <= Math.max(ax,bx) &&
         Math.min(ay,by) <= py && py <= Math.max(ay,by);
}

function segmentsIntersect(l1, l2) {
  const { x1:ax, y1:ay, x2:bx, y2:by } = l1;
  const { x1:cx, y1:cy, x2:dx, y2:dy } = l2;

  // 端点共有は交差にカウントしない
  if ((ax===cx&&ay===cy)||(ax===dx&&ay===dy)||
      (bx===cx&&by===cy)||(bx===dx&&by===dy)) return false;

  const d1 = (dx-cx)*(ay-cy) - (dy-cy)*(ax-cx);
  const d2 = (dx-cx)*(by-cy) - (dy-cy)*(bx-cx);
  const d3 = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
  const d4 = (bx-ax)*(dy-ay) - (by-ay)*(dx-ax);

  if (((d1>0&&d2<0)||(d1<0&&d2>0)) &&
      ((d3>0&&d4<0)||(d3<0&&d4>0))) return true;

  // 共線（collinear）ケース
  if (d1===0 && _onSeg(ax,ay,cx,cy,dx,dy)) return true;
  if (d2===0 && _onSeg(bx,by,cx,cy,dx,dy)) return true;
  if (d3===0 && _onSeg(cx,cy,ax,ay,bx,by)) return true;
  if (d4===0 && _onSeg(dx,dy,ax,ay,bx,by)) return true;

  return false;
}

function countIntersections(lines) {
  let n = 0;
  for (let i = 0; i < lines.length; i++)
    for (let j = i+1; j < lines.length; j++)
      if (segmentsIntersect(lines[i], lines[j])) n++;
  return n;
}

function validateIntersections(lines, level) {
  const n = countIntersections(lines);
  if (level === 0) return n >= 1 && n <= 2;
  if (level === 1) return n >= 1 && n <= 3;
  if (level === 2) return n >= 3 && n <= 5;
  return true;
}

// ─── プロンプト生成 ──────────────────────────────────────────────────
function buildPrompt(level, count) {
  const specs = {
    0: { grid:'4x4', lines:4,
         cross:'端点共有を除く内部交差が必ず1〜2箇所',
         hint:'lines配列の最初の3本がヒントとして表示される（4本目だけユーザーが描く）' },
    1: { grid:'4x4', lines:4,
         cross:'端点共有を除く内部交差が必ず1〜3箇所',
         hint:'lines配列の最初の2本がヒントとして表示される' },
    2: { grid:'4x4', lines:'4〜5',
         cross:'端点共有を除く内部交差が必ず3〜5箇所',
         hint:'ヒントなし' },
    3: { grid:'5x5', lines:'5〜7',
         cross:'交差数制限なし',
         hint:'ヒントなし' },
  };
  const s = specs[level] ?? specs[1];
  const [cols, rows] = s.grid.split('x').map(Number);

  return `
あなたは幼児向け図形模写パズルの問題作成AIです。
以下の仕様に従い、見た目が異なる図形を${count}問作成してください。

【仕様】
- グリッド: ${s.grid}（座標は0始まり整数、x: 0〜${cols-1}, y: 0〜${rows-1}）
- 1問あたりの線の本数: ${s.lines}本
- 交差制約: ${s.cross}
- ${s.hint}
- 全問で構成が重複しないこと

【交差カウントの定義】
2本の線分が端点を共有せずに内部で交わる点を「1交差」とカウントします。
端点が一致している場合は交差にカウントしません。
出力前に自分で交差数を数えて制約を満たしているか確認してください。

【出力形式】
JSON配列のみを出力し、説明文・コメントは一切含めないこと。
[
  {
    "level": ${level},
    "grid": {"cols": ${cols}, "rows": ${rows}},
    "lines": [{"x1":0,"y1":0,"x2":2,"y2":2}, ...]
  }
]
`.trim();
}

// ─── 問題生成メイン ──────────────────────────────────────────────────
async function generateProblems(level, count, apiKey) {
  const model = await resolveModel(apiKey);
  const MAX_RETRY = 5;

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const res = await fetch(
        `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildPrompt(level, count) }] }],
            generationConfig: { temperature: 0.9, maxOutputTokens: 4096 }
          })
        }
      );

      if (!res.ok) {
        if (res.status === 429) await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const data  = await res.json();
      const text  = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) continue;

      let rawProblems;
      try { rawProblems = JSON.parse(match[0]); }
      catch { continue; }
      if (!Array.isArray(rawProblems)) continue;

      // 正規化
      const normalized = rawProblems
        .map(p => normalizeProblem(p, level))
        .filter(p => p.lines.length >= 2);

      // 交差数バリデーション
      const passed   = normalized.filter(p => validateIntersections(p.lines, level));
      const fallback = (PROBLEM_BANK[level] || PROBLEM_BANK[1])
        .slice()
        .sort(() => Math.random() - 0.5);

      // 不足分をフォールバックで補完
      const result = [...passed];
      for (const fb of fallback) {
        if (result.length >= count) break;
        result.push(normalizeProblem(fb, level));
      }

      if (result.length > 0) return result.slice(0, count);

    } catch (e) {
      console.warn(`generateProblems attempt ${attempt + 1} failed:`, e);
    }
  }

  // 全リトライ失敗 → フォールバックバンクのみで返す
  clearModelCache();
  return (PROBLEM_BANK[level] || PROBLEM_BANK[1])
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, count)
    .map(p => normalizeProblem(p, level));
}

// ─── APIキー管理 ─────────────────────────────────────────────────────
function saveApiKey(key) {
  try { localStorage.setItem('gemini_api_key', key); } catch {}
  clearModelCache();
}

function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; }
  catch { return ''; }
}
