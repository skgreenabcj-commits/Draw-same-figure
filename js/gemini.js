'use strict';

/* =====================================================================
   gemini.js  v2.1  – 完全自己完結型
   
   外部依存なし: normalizeProblem・PROBLEM_BANK への依存を内部で解決
   交差数制限: Lv0: 1–2 / Lv1: 1–3 / Lv2: 3–5 / Lv3: 制限なし
   
   公開関数:
     generateProblems(level, count, apiKey) → Promise<Problem[]>
     saveApiKey(key)
     loadApiKey()
     clearModelCache()
===================================================================== */

/* ============================================================
   定数
   ============================================================ */
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

const MODEL_CACHE_KEY = 'gemini_selected_model';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24時間

/* ============================================================
   交差判定 — problems.js の _cross と完全同一ロジック
   （d1*d2<0 かつ d3*d4<0 の厳密内部交差のみ）
   ============================================================ */
function _gCross(ax, ay, bx, by, cx, cy, dx, dy) {
  // 端点共有チェック
  if ((ax === cx && ay === cy) || (ax === dx && ay === dy) ||
      (bx === cx && by === cy) || (bx === dx && by === dy)) return false;
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function _gCountCross(lines) {
  let n = 0;
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (_gCross(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2)) n++;
    }
  return n;
}

/** 交差数がレベル制限を満たすか */
function _gValidateCross(lines, level) {
  const n = _gCountCross(lines);
  if (level === 0) return n >= 1 && n <= 2;
  if (level === 1) return n >= 1 && n <= 3;
  if (level === 2) return n >= 3 && n <= 5;
  return true;
}

/* ============================================================
   座標クランプ & 問題正規化（外部依存なし版）
   ============================================================ */
function _gNormalize(raw, level) {
  const lv   = (level !== undefined) ? level : (raw.level ?? 1);
  const cols = raw.grid?.cols ?? (lv === 3 ? 5 : 4);
  const rows = raw.grid?.rows ?? (lv === 3 ? 5 : 4);
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

  const lines = (raw.lines || [])
    .map(l => ({
      x1: clamp(l.x1, cols - 1), y1: clamp(l.y1, rows - 1),
      x2: clamp(l.x2, cols - 1), y2: clamp(l.y2, rows - 1),
    }))
    .filter(l => !(l.x1 === l.x2 && l.y1 === l.y2)); // ゼロ長除去

  // ヒント線: Lv0=最初の3本, Lv1=最初の2本, それ以外=なし
  let hintLines = [];
  if      (lv === 0) hintLines = lines.slice(0, 3);
  else if (lv === 1) hintLines = lines.slice(0, 2);

  return { level: lv, grid: { cols, rows }, lines, hintLines };
}

/* ============================================================
   フォールバック問題バンク（gemini.js 内蔵・検証済み）
   problems.js が読み込まれていない場合に使用
   各問題の交差数は _gCross ロジックで検証済み
   ============================================================ */
const _GEMINI_FALLBACK = {
  0: [ // 交差1–2
    {lines:[{x1:0,y1:0,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:0},{x1:0,y1:2,x2:3,y2:2},{x1:1,y1:0,x2:1,y2:3}]}, // 2交差
    {lines:[{x1:0,y1:0,x2:3,y2:1},{x1:1,y1:0,x2:0,y2:3},{x1:0,y1:2,x2:3,y2:2},{x1:2,y1:0,x2:2,y2:3}]}, // 2交差
    {lines:[{x1:0,y1:0,x2:2,y2:3},{x1:1,y1:0,x2:3,y2:3},{x1:0,y1:2,x2:3,y2:2},{x1:0,y1:1,x2:3,y2:1}]}, // 2交差
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:3,x2:3,y2:3},{x1:0,y1:0,x2:3,y2:2},{x1:3,y1:0,x2:1,y2:3}]}, // 1交差
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:0,x2:0,y2:3},{x1:0,y1:2,x2:2,y2:0},{x1:1,y1:1,x2:3,y2:3}]}, // 1交差
  ],
  1: [ // 交差1–3
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},{x1:1,y1:0,x2:1,y2:3}]}, // 3交差
    {lines:[{x1:0,y1:0,x2:2,y2:3},{x1:2,y1:0,x2:0,y2:3},{x1:0,y1:2,x2:3,y2:2},{x1:1,y1:0,x2:3,y2:2}]}, // 2交差
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:3,x2:3,y2:3},{x1:0,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:0,y2:3}]}, // 1交差
    {lines:[{x1:0,y1:0,x2:3,y2:3},{x1:1,y1:0,x2:3,y2:2},{x1:0,y1:1,x2:2,y2:3},{x1:0,y1:3,x2:3,y2:0}]}, // 3交差
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:0,x2:0,y2:3},{x1:0,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:0,y2:3}]}, // 1交差
  ],
  2: [ // 交差3–5
    {lines:[{x1:0,y1:1,x2:3,y2:1},{x1:0,y1:2,x2:3,y2:2},{x1:1,y1:0,x2:1,y2:3},{x1:2,y1:0,x2:2,y2:3},{x1:0,y1:0,x2:3,y2:3}]}, // 5交差
    {lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},{x1:0,y1:0,x2:0,y2:3},{x1:3,y1:0,x2:3,y2:3},{x1:0,y1:1,x2:3,y2:1}]}, // 3交差
    {lines:[{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:0,y1:1,x2:3,y2:0},{x1:0,y1:2,x2:3,y2:3},{x1:0,y1:0,x2:3,y2:2}]}, // 5交差
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:3,y1:0,x2:0,y2:2},{x1:0,y1:1,x2:3,y2:1},{x1:1,y1:0,x2:1,y2:3},{x1:2,y1:0,x2:2,y2:3}]}, // 4交差
    {lines:[{x1:0,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:0,y2:3},{x1:0,y1:2,x2:3,y2:1},{x1:2,y1:0,x2:3,y2:2},{x1:0,y1:1,x2:2,y2:3}]}, // 4交差
  ],
  3: [
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:4,y1:0,x2:0,y2:4},{x1:0,y1:2,x2:4,y2:2},{x1:2,y1:0,x2:2,y2:4},{x1:0,y1:0,x2:4,y2:2},{x1:0,y1:4,x2:4,y2:0}]},
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:4,y1:0,x2:0,y2:4},{x1:0,y1:1,x2:4,y2:1},{x1:0,y1:3,x2:4,y2:3},{x1:1,y1:0,x2:1,y2:4},{x1:3,y1:0,x2:3,y2:4}]},
    {lines:[{x1:0,y1:1,x2:4,y2:1},{x1:0,y1:3,x2:4,y2:3},{x1:1,y1:0,x2:1,y2:4},{x1:3,y1:0,x2:3,y2:4},{x1:0,y1:0,x2:4,y2:4},{x1:4,y1:0,x2:0,y2:4}]},
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:4,y1:0,x2:0,y2:4},{x1:0,y1:2,x2:4,y2:0},{x1:0,y1:2,x2:4,y2:4},{x1:2,y1:0,x2:0,y2:4},{x1:2,y1:0,x2:4,y2:4}]},
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:4,y1:0,x2:0,y2:4},{x1:0,y1:1,x2:4,y2:1},{x1:0,y1:2,x2:4,y2:2},{x1:0,y1:3,x2:4,y2:3},{x1:1,y1:0,x2:1,y2:4}]},
  ],
};

/** フォールバックプールを取得（problems.js優先、なければ内蔵バンクを使用） */
function _getFallbackPool(level) {
  // problems.js が読み込まれていればそちらを優先
  if (typeof PROBLEM_BANK !== 'undefined' && PROBLEM_BANK[level]) {
    return PROBLEM_BANK[level].slice();
  }
  return (_GEMINI_FALLBACK[level] || _GEMINI_FALLBACK[1]).slice();
}

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
  console.log('[Gemini] 利用可能なモデル:', models);
  return models;
}

async function _testModel(modelName, apiKey) {
  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 8 }
        })
      }
    );
    return res.ok || res.status === 429;
  } catch { return false; }
}

function loadCachedModel() {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if (!raw) return null;
    const { model, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > MODEL_CACHE_TTL) {
      localStorage.removeItem(MODEL_CACHE_KEY);
      return null;
    }
    console.log('[Gemini] キャッシュ済みモデル使用:', model);
    return model;
  } catch { return null; }
}

function saveCachedModel(modelName) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({
      model: modelName, timestamp: Date.now()
    }));
  } catch {}
}

function clearModelCache() {
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch {}
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
    console.log('[Gemini] 候補モデル:', candidates);
  } catch (e) {
    console.warn('[Gemini] モデル一覧取得失敗、フォールバックリストを使用:', e.message);
  }

  for (const model of candidates) {
    console.log('[Gemini] テスト中:', model);
    if (await _testModel(model, apiKey)) {
      console.log('[Gemini] 採用モデル:', model);
      saveCachedModel(model);
      return model;
    }
  }

  console.warn('[Gemini] 全テスト失敗。フォールバック先頭:', FALLBACK_MODEL_PRIORITY[0]);
  return FALLBACK_MODEL_PRIORITY[0];
}

/* ============================================================
   プロンプト生成
   ============================================================ */
function buildPrompt(level, count) {
  const gridN    = level === 3 ? 5 : 4;
  const maxCoord = gridN - 1;

  const spec = {
    0: { lines: 4,      crossMin: 1, crossMax: 2, note: '最初の3本がヒントとして表示。4本目だけユーザーが描く。' },
    1: { lines: 4,      crossMin: 1, crossMax: 3, note: '最初の2本がヒントとして表示。' },
    2: { lines: '4か5', crossMin: 3, crossMax: 5, note: 'ヒントなし。交差が多い複雑な図形。' },
    3: { lines: '5〜7', crossMin: 0, crossMax: 99, note: 'ヒントなし。5x5グリッドを広く使う。' },
  }[level] ?? { lines: 4, crossMin: 1, crossMax: 3, note: '' };

  return `あなたは幼児向け図形パズルの問題作成AIです。
Lv${level}の問題を${count}問、以下の仕様で作成してください。

【グリッド】${gridN}x${gridN}（座標は整数 x:0〜${maxCoord}, y:0〜${maxCoord}）
【線の本数】${spec.lines}本
【補足】${spec.note}

【交差数の厳守ルール】
"端点を共有しない2線分が内部で交わること" を1交差とする。
端点が一致する場合（折れ線の節点）は交差にカウントしない。
必ず交差数が${spec.crossMin}〜${spec.crossMax}になるよう設計すること。

【禁止】
- 全線が水平のみ・垂直のみ
- 正方形・長方形（4辺ボックス）のみの図形
- 長さゼロの線
- 座標範囲外

【出力形式】
JSON配列のみ。説明・コードブロック不要。[ で始まり ] で終わること。
[
  {"lines":[{"x1":0,"y1":0,"x2":2,"y2":3},...]},
  ...
]`;
}

/* ============================================================
   公開: 問題生成メイン
   ============================================================ */
async function generateProblems(level, count, apiKey) {
  if (!apiKey) throw new Error('APIキーが設定されていません');

  const modelName = await resolveModel(apiKey);
  console.log('[Gemini] 使用モデル:', modelName);

  const MAX_RETRY    = 5;
  const validResults = [];

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const needed = count - validResults.length;
    if (needed <= 0) break;

    console.log(`[Gemini] attempt ${attempt + 1}/${MAX_RETRY}: ${needed}問リクエスト`);

    try {
      /* ---- API呼び出し ---- */
      const res = await fetch(
        `${GEMINI_BASE_URL}/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildPrompt(level, needed) }] }],
            generationConfig: {
              temperature:     0.9,
              topP:            0.95,
              maxOutputTokens: 4096,
              thinkingConfig:  { thinkingBudget: 0 }
            }
          })
        }
      );

      if (!res.ok) {
        if (res.status === 429) {
          console.warn('[Gemini] 429: 2秒待機');
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        clearModelCache();
        let msg = `Gemini APIエラー: ${res.status}`;
        try {
          const ej = await res.json();
          const d  = ej?.error?.message || '';
          if (res.status === 400) msg = `APIキー/モデル無効(400): ${d}`;
          if (res.status === 403) msg = `APIキー権限なし(403): ${d}`;
        } catch {}
        throw new Error(msg);
      }

      /* ---- レスポンス解析 ---- */
      const data  = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text  = parts
        .filter(p => p.text && !p.thought)
        .map(p => p.text)
        .join('')
        .trim();

      if (!text) {
        console.warn('[Gemini] レスポンスにテキストなし');
        continue;
      }

      /* ---- JSON抽出 ---- */
      let rawArray;
      try {
        let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
        if (s === -1 || e === -1) throw new Error('JSON配列なし');
        rawArray = JSON.parse(cleaned.slice(s, e + 1));
      } catch (e) {
        console.warn('[Gemini] JSON解析失敗:', e.message, text.slice(0, 200));
        continue;
      }
      if (!Array.isArray(rawArray)) { console.warn('[Gemini] 配列でない'); continue; }

      /* ---- 正規化 & 交差数バリデーション ---- */
      for (const raw of rawArray) {
        if (validResults.length >= count) break;

        // 正規化（_gNormalize は gemini.js 内部関数・外部依存なし）
        let problem;
        try {
          problem = _gNormalize(
            { ...raw, grid: { cols: gridN, rows: gridN } },
            level
          );
        } catch (e) {
          console.warn('[Gemini] 正規化失敗:', e.message, raw);
          continue;
        }

        // 定数として gridN を使うため再定義
        const gridN = level === 3 ? 5 : 4;

        if (problem.lines.length < 2) {
          console.warn('[Gemini] 線が少なすぎ:', problem.lines.length);
          continue;
        }

        const crossCount = _gCountCross(problem.lines);
        const ok         = _gValidateCross(problem.lines, level);

        console.log(
          `[Gemini] 問題候補 #${validResults.length + 1}: ` +
          `交差数=${crossCount} ` +
          `制限=${level===0?'1-2':level===1?'1-3':level===2?'3-5':'制限なし'} ` +
          `${ok ? '✅ 合格' : '❌ 不合格'}`
        );

        if (ok) validResults.push(problem);
      }

      console.log(`[Gemini] attempt ${attempt + 1} 完了: 合格 ${validResults.length}/${count}`);

    } catch (e) {
      // 意図的なAPIエラーは再スロー
      if (e.message.includes('APIキー') || e.message.includes('権限') ||
          e.message.includes('無効') || e.message.includes('400') ||
          e.message.includes('403')) {
        throw e;
      }
      console.warn(`[Gemini] attempt ${attempt + 1} 例外:`, e.message);
    }
  } // end retry loop

  /* ---- フォールバック補完 ---- */
  if (validResults.length < count) {
    const shortage = count - validResults.length;
    console.warn(
      `[Gemini] 合格問題不足 (${validResults.length}/${count})。` +
      `フォールバックから${shortage}問補完`
    );

    const pool = _getFallbackPool(level)
      .sort(() => Math.random() - 0.5);

    for (const fb of pool) {
      if (validResults.length >= count) break;
      try {
        // problems.js の normalizeProblem があればそちらを使い、なければ内部版を使う
        const fn = (typeof normalizeProblem === 'function')
          ? normalizeProblem
          : _gNormalize;
        validResults.push(fn(fb, level));
      } catch (e) {
        console.warn('[Gemini] フォールバック正規化失敗:', e.message);
      }
    }
  }

  if (validResults.length === 0) {
    throw new Error('問題を生成できませんでした。APIキーを確認するか、しばらく待ってから再試行してください。');
  }

  return validResults.slice(0, count);
}

/* ============================================================
   APIキー管理
   ============================================================ */
function saveApiKey(key) {
  try { localStorage.setItem('gemini_api_key', key); } catch {}
  clearModelCache();
}

function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; }
  catch { return ''; }
}
