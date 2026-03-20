'use strict';

/* =====================================================================
   gemini.js  – Gemini API 連携 + 動的モデル選択  v2.0
   
   【設計方針】
   1. モデル選択: /v1beta/models API → 優先リスト照合 → 疎通テスト → キャッシュ
   2. 問題生成: 交差数制約をプロンプトに明示 → クライアント側で厳密検証
   3. 交差判定: problems.js の _cross と完全同一のロジックを使用
   4. バリデーション失敗時: 最大5回リトライ → fallback補完
   =====================================================================
   
   交差数制限: Lv0: 1–2 / Lv1: 1–3 / Lv2: 3–5 / Lv3: 制限なし
===================================================================== */

/* ============================================================
   定数
   ============================================================ */
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Free tier で利用可能なモデルの優先順位リスト
 * 上位ほど優先して使用する
 */
const FALLBACK_MODEL_PRIORITY = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.0-pro'
];

/** モデルキャッシュのキーと有効期限（24時間） */
const MODEL_CACHE_KEY = 'gemini_selected_model';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

/* ============================================================
   交差判定ユーティリティ
   ★ problems.js の _cross 関数と完全同一のロジック
     （端点共有を除く厳密内部交差のみをカウント）
   ★ gemini.js 内に独立して定義し、読み込み順に依存しない
   ============================================================ */

/**
 * 2線分が端点共有なしで内部交差するか判定する
 * @param {number} ax,ay,bx,by - 線分1の始点・終点
 * @param {number} cx,cy,dx,dy - 線分2の始点・終点
 * @returns {boolean}
 */
function _crossCheck(ax, ay, bx, by, cx, cy, dx, dy) {
  // 端点共有チェック（共有している場合は交差にカウントしない）
  if ((ax === cx && ay === cy) || (ax === dx && ay === dy) ||
      (bx === cx && by === cy) || (bx === dx && by === dy)) {
    return false;
  }
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  // 厳密な内部交差のみ: 両方の積が負（異符号）
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * 線分配列の全ペアについて交差数を数える
 * @param {Array<{x1,y1,x2,y2}>} lines
 * @returns {number}
 */
function _countCrossings(lines) {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (_crossCheck(a.x1, a.y1, a.x2, a.y2,
                      b.x1, b.y1, b.x2, b.y2)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * レベルに応じた交差数制約を満たすか検証する
 * @param {Array<{x1,y1,x2,y2}>} lines
 * @param {number} level
 * @returns {boolean}
 */
function _validateCrossings(lines, level) {
  const n = _countCrossings(lines);
  if (level === 0) return n >= 1 && n <= 2;
  if (level === 1) return n >= 1 && n <= 3;
  if (level === 2) return n >= 3 && n <= 5;
  return true; // Lv3: 制限なし
}

/* ============================================================
   モデル選択ロジック
   ============================================================ */

/**
 * Gemini API からテキスト生成可能なモデル一覧を取得する
 * @param {string} apiKey
 * @returns {Promise<string[]>} モデル名の配列（例: ['gemini-2.5-flash', ...]）
 */
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

/**
 * モデルが generateContent を受け付けるか疎通テストする
 * 最小リクエストで確認し、429（レート超過）も「使える」とみなす
 * @param {string} modelName
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
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
  } catch {
    return false;
  }
}

/**
 * キャッシュからモデル名を読み込む（TTL切れは null）
 * @returns {string|null}
 */
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
  } catch {
    return null;
  }
}

/**
 * 選択したモデルをキャッシュに保存する
 * @param {string} modelName
 */
function saveCachedModel(modelName) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({
      model:     modelName,
      timestamp: Date.now()
    }));
  } catch {}
}

/**
 * モデルキャッシュを強制クリアする
 * APIキー変更時などに外部から呼ぶ
 */
function clearModelCache() {
  try { localStorage.removeItem(MODEL_CACHE_KEY); } catch {}
}

/**
 * 使用するモデルを動的に決定する
 *
 * 手順:
 *  1. キャッシュが有効なら即返す
 *  2. /v1beta/models API で利用可能なモデルを取得
 *  3. FALLBACK_MODEL_PRIORITY と照合し、優先順で候補リストを構築
 *     （优先リストにないが API で取得できた gemini-flash/pro 系も後ろに追加）
 *  4. 候補を順番に疎通テストし、最初に成功したものをキャッシュして返す
 *  5. 全て失敗した場合はフォールバックリスト先頭を返す
 *
 * @param {string} apiKey
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

    // 優先リストに含まれるものを優先順で
    const fromPriority = FALLBACK_MODEL_PRIORITY.filter(m => available.includes(m));

    // 優先リストにないが API で取得できた gemini-flash/pro 系も後ろに追加
    const extra = available.filter(
      m => !FALLBACK_MODEL_PRIORITY.includes(m) &&
           (m.includes('flash') || m.includes('pro'))
    );

    candidates = [...fromPriority, ...extra];
    console.log('[Gemini] 候補モデル:', candidates);
  } catch (e) {
    console.warn('[Gemini] モデル一覧取得失敗、フォールバックリストを使用:', e.message);
  }

  // 3. 候補を順番に疎通テスト
  for (const model of candidates) {
    console.log('[Gemini] テスト中:', model);
    if (await _testModel(model, apiKey)) {
      console.log('[Gemini] 採用モデル:', model);
      saveCachedModel(model);
      return model;
    }
  }

  // 4. 全て失敗 → フォールバック先頭を使う
  console.warn('[Gemini] 全モデルテスト失敗。フォールバック使用:', FALLBACK_MODEL_PRIORITY[0]);
  return FALLBACK_MODEL_PRIORITY[0];
}

/* ============================================================
   プロンプト生成
   交差制約を日本語で明示し、AIが自己チェックするよう誘導
   ============================================================ */

/**
 * レベル別のプロンプトを生成する
 * @param {number} level
 * @param {number} count
 * @returns {string}
 */
function buildPrompt(level, count) {
  const isLv3   = level === 3;
  const gridN   = isLv3 ? 5 : 4;
  const maxCoord = gridN - 1; // 0始まりの最大値
  const gridDesc = `${gridN}x${gridN}グリッド（座標は整数、x: 0〜${maxCoord}, y: 0〜${maxCoord}）`;

  // レベル別の制約
  const levelSpec = {
    0: {
      lineCount:   '4本',
      crossRule:   '端点共有を除く内部交差が【必ず1〜2箇所】',
      crossMin:    1,
      crossMax:    2,
      note:        'lines配列の最初の3本がヒントとして表示される（4本目だけユーザーが描く）'
    },
    1: {
      lineCount:   '4本',
      crossRule:   '端点共有を除く内部交差が【必ず1〜3箇所】',
      crossMin:    1,
      crossMax:    3,
      note:        'lines配列の最初の2本がヒントとして表示される'
    },
    2: {
      lineCount:   '4〜5本',
      crossRule:   '端点共有を除く内部交差が【必ず3〜5箇所】',
      crossMin:    3,
      crossMax:    5,
      note:        'ヒントなし。複雑な図形を作ること'
    },
    3: {
      lineCount:   '5〜7本',
      crossRule:   '交差数制限なし（多いほどよい）',
      crossMin:    0,
      crossMax:    999,
      note:        'ヒントなし。5x5グリッドを広く使う複雑な図形'
    }
  }[level] ?? {
    lineCount: '4本', crossRule: '交差1〜3箇所', crossMin: 1, crossMax: 3, note: ''
  };

  return `あなたは幼児向け図形模写パズルの問題を作成するAIです。
以下の仕様に厳密に従い、見た目が異なる図形を${count}問作成してください。

【グリッド仕様】
${gridDesc}

【1問あたりの線の本数】
${levelSpec.lineCount}

【交差制約（最重要・厳守すること）】
${levelSpec.crossRule}

交差のカウントルール:
- 2本の線分が「端点を共有せず」に内部で交わる点を「1交差」とカウントする
- 端点が一致している場合（折れ線の接続点など）は交差にカウントしない
- 交差数が${levelSpec.crossMin}未満または${levelSpec.crossMax}超の問題は不正解とみなす

【補足】
${levelSpec.note}

【出力前の自己チェック手順（必ず実行すること）】
各問題について:
1. 全線分ペアを列挙する
2. 各ペアについて「端点共有なし」かつ「内部交差あり」かを確認する
3. 交差数が${levelSpec.crossMin}〜${levelSpec.crossMax}の範囲内であることを確認する
4. 範囲外の場合は線の組み合わせを変えて再設計する

【禁止事項】
- 正方形・長方形（4辺のみ）
- 全線分が水平のみ、または垂直のみ
- 長さゼロの線（始点と終点が同一）
- 同一の線分の重複

【出力形式】
JSON配列のみを出力すること。説明文・コメント・コードブロックは一切含めないこと。
配列は [ で始まり ] で終わること。

[
  {
    "level": ${level},
    "grid": {"cols": ${gridN}, "rows": ${gridN}},
    "lines": [
      {"x1": 0, "y1": 0, "x2": 2, "y2": 3},
      ...
    ]
  }
]`;
}

/* ============================================================
   公開: 問題生成メイン関数
   ============================================================ */

/**
 * Gemini API を使って問題を生成する
 *
 * バリデーション戦略:
 *  - 最大 MAX_RETRY 回リトライ
 *  - 各試行で交差数が制約を満たす問題のみ採用
 *  - 採用数が count に満たない場合、PROBLEM_BANK からフォールバック補完
 *  - 全リトライ失敗時は PROBLEM_BANK のみで返す
 *
 * @param {number} level   難易度レベル (0–3)
 * @param {number} count   生成する問題数
 * @param {string} apiKey  Gemini API キー
 * @returns {Promise<Array>} 正規化された問題オブジェクトの配列
 */
async function generateProblems(level, count, apiKey) {
  if (!apiKey) throw new Error('APIキーが設定されていません');

  const modelName = await resolveModel(apiKey);
  console.log('[Gemini] 使用モデル:', modelName);

  const MAX_RETRY    = 5;
  const validResults = []; // 交差数チェック通過済みの問題を蓄積

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    // 必要な残り問題数だけリクエスト（すでに確保済みは除く）
    const needed = count - validResults.length;
    if (needed <= 0) break;

    console.log(`[Gemini] attempt ${attempt + 1}/${MAX_RETRY}: ${needed}問リクエスト`);

    try {
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
              // thinkingConfig は gemini-2.5-flash 以外では無視されるため安全に付与
              thinkingConfig:  { thinkingBudget: 0 }
            }
          })
        }
      );

      if (!res.ok) {
        if (res.status === 429) {
          console.warn('[Gemini] 429: レート超過。2秒待機して再試行');
          await new Promise(r => setTimeout(r, 2000));
        } else {
          // 4xx 系はキャッシュをクリアして再モデル選択できるようにする
          clearModelCache();
          let errMsg = `Gemini API エラー: ${res.status}`;
          try {
            const errJson = await res.json();
            const detail  = errJson?.error?.message || '';
            if (res.status === 400) errMsg = `APIキーまたはモデル指定が無効です（400）。\n${detail}`;
            if (res.status === 403) errMsg = 'APIキーに権限がありません（403）。\nGemini APIが有効か確認してください。';
          } catch {}
          throw new Error(errMsg);
        }
        continue;
      }

      const data = await res.json();

      // Thinking モデルは parts が複数になるため thought パートを除外して結合
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text  = parts
        .filter(p => p.text && !p.thought)
        .map(p => p.text)
        .join('')
        .trim();

      if (!text) {
        console.warn('[Gemini] レスポンスにテキストなし:', JSON.stringify(data).slice(0, 200));
        continue;
      }

      // JSON 抽出（コードブロックや前後テキストを除去）
      let rawArray;
      try {
        let cleaned = text
          .replace(/```(?:json)?\s*/gi, '')
          .replace(/```/g, '')
          .trim();
        const start = cleaned.indexOf('[');
        const end   = cleaned.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error('JSON配列が見つかりません');
        cleaned  = cleaned.slice(start, end + 1);
        rawArray = JSON.parse(cleaned);
      } catch (e) {
        console.warn('[Gemini] JSON解析失敗:', e.message, '| raw:', text.slice(0, 300));
        continue;
      }

      if (!Array.isArray(rawArray)) {
        console.warn('[Gemini] パース結果が配列でない');
        continue;
      }

      // --- 正規化 & 交差数バリデーション ---
      for (const raw of rawArray) {
        if (validResults.length >= count) break;

        // 正規化（problems.js の normalizeProblem を使用）
        const problem = normalizeProblem(
          { ...raw, grid: { cols: (level === 3 ? 5 : 4), rows: (level === 3 ? 5 : 4) } },
          level
        );

        // 線が2本以上あること
        if (problem.lines.length < 2) {
          console.warn('[Gemini] 線が少なすぎる問題をスキップ:', problem.lines);
          continue;
        }

        // 交差数チェック（problems.js の _cross と同一ロジック）
        const crossCount = _countCrossings(problem.lines);
        const valid      = _validateCrossings(problem.lines, level);

        console.log(
          `[Gemini] 問題 ${validResults.length + 1}: 交差数=${crossCount} ` +
          `${valid ? '✅ 合格' : '❌ 不合格（制約違反）'}`
        );

        if (valid) {
          validResults.push(problem);
        }
      }

      console.log(`[Gemini] attempt ${attempt + 1} 終了: 合格済み ${validResults.length}/${count}`);

    } catch (e) {
      // 意図的に throw した Error はそのまま再スロー
      if (e.message.includes('APIキー') ||
          e.message.includes('権限') ||
          e.message.includes('無効')) {
        throw e;
      }
      console.warn(`[Gemini] attempt ${attempt + 1} 例外:`, e.message);
    }
  }

  // --- フォールバック補完 ---
  if (validResults.length < count) {
    const shortage = count - validResults.length;
    console.warn(
      `[Gemini] ${MAX_RETRY}回試行後、合格問題が不足 (${validResults.length}/${count})。` +
      `フォールバックバンクから${shortage}問補完`
    );

    const fallbackPool = (
      typeof PROBLEM_BANK !== 'undefined'
        ? (PROBLEM_BANK[level] || PROBLEM_BANK[1])
        : []
    ).slice().sort(() => Math.random() - 0.5);

    for (const fb of fallbackPool) {
      if (validResults.length >= count) break;
      validResults.push(normalizeProblem(fb, level));
    }
  }

  // それでも足りない場合（PROBLEM_BANKが空など）は持っている分を返す
  if (validResults.length === 0) {
    throw new Error('問題を生成できませんでした。APIキーを確認するか、しばらく待ってから再試行してください。');
  }

  return validResults.slice(0, count);
}

/* ============================================================
   APIキーの保存・読み込み
   キー変更時はモデルキャッシュもリセットする
   ============================================================ */

/**
 * APIキーをローカルストレージに保存する
 * @param {string} key
 */
function saveApiKey(key) {
  try {
    localStorage.setItem('gemini_api_key', key);
    clearModelCache(); // キー変更時はモデルキャッシュをリセット
  } catch {}
}

/**
 * 保存済みAPIキーを取得する
 * @returns {string}
 */
function loadApiKey() {
  try { return localStorage.getItem('gemini_api_key') || ''; }
  catch { return ''; }
}
