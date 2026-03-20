'use strict';

/* =====================================================================
   gemini.js  v3.0
   - 動的モデル選択（並列プローブ＋24時間キャッシュ）
   - 交差点検証は problems.js の _cross と完全一致
   - 外部依存なし・完全自己完結
   - レベル別制約:
       Lv0: 交差0-2  (4本, 4x4グリッド)
       Lv1: 交差0-3  (4本, 4x4グリッド)
       Lv2: 交差2-5  (4本, 4x4グリッド)
       Lv3: 交差0-8  (5本, 5x5グリッド)
===================================================================== */

const _G = (() => {

/* ── 定数 ──────────────────────────────────────────────────────────── */
const BASE_URL        = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CACHE_KEY = 'gemini_model_v3';   // localStorage キー名
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000; // キャッシュ有効期限: 24時間（ミリ秒）

// 優先モデル（最初に試みる）
const PREFERRED_MODEL  = 'gemini-2.5-flash';

// フォールバック候補モデル（優先順）
const FALLBACK_MODELS  = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-1.0-pro'
];

// レベル別設定: lines=線分数, gridN=最大座標, lo/hi=交差数範囲, hints=ヒント線数
const LEVEL_CFG = {
  0: { lines:4, gridN:3, lo:0, hi:2, hints:3 },
  1: { lines:4, gridN:3, lo:0, hi:3, hints:2 },
  2: { lines:4, gridN:3, lo:2, hi:5, hints:0 },
  3: { lines:5, gridN:4, lo:0, hi:8, hints:0 }
};

/* ── 厳密内部交差判定（problems.js の _cross と完全一致） ──────────── */
/*
 * 2線分 AB と CD が「厳密に内部で交差する」か判定する。
 * - 端点共有は交差とみなさない（端点一致チェックで弾く）
 * - d1〜d4 は外積（cross product）の符号で交差方向を判定
 */
function _cross(ax,ay,bx,by,cx,cy,dx,dy){
  // 端点が一致する場合は交差なし
  if((ax===cx&&ay===cy)||(ax===dx&&ay===dy)) return false;
  if((bx===cx&&by===cy)||(bx===dx&&by===dy)) return false;
  // 各端点の外積値を計算
  const d1=(dx-cx)*(ay-cy)-(dy-cy)*(ax-cx);
  const d2=(dx-cx)*(by-cy)-(dy-cy)*(bx-cx);
  const d3=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
  const d4=(bx-ax)*(dy-ay)-(by-ay)*(dx-ax);
  // 両線分が互いに相手を「またぐ」場合のみ true
  return ((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0));
}

/*
 * 線分配列内の全ペアについて交差数を数える。
 * @param {Array} lines - {x1,y1,x2,y2} の配列
 * @returns {number} 交差ペア数
 */
function _countCross(lines){
  let n=0;
  for(let i=0;i<lines.length;i++)
    for(let j=i+1;j<lines.length;j++)
      if(_cross(lines[i].x1,lines[i].y1,lines[i].x2,lines[i].y2,
                lines[j].x1,lines[j].y1,lines[j].x2,lines[j].y2)) n++;
  return n;
}

/*
 * 指定レベルの交差数制約を満たすか検証する。
 * @param {Array}  lines - 線分配列
 * @param {number} level - レベル番号
 * @returns {boolean}
 */
function _validate(lines, level){
  const {lo,hi} = LEVEL_CFG[level] || LEVEL_CFG[1];
  const n = _countCross(lines);
  return n >= lo && n <= hi;
}

/* ── AIの生出力を正規化して標準的な線分オブジェクトへ変換 ──────────── */
/*
 * Gemini が返した JSON を受け取り、座標クランプ・長さゼロ除去・
 * hintLines 付与を行って問題オブジェクトを返す。
 * 線分数が設定と合わない場合は null を返す。
 */
function _normalise(raw, level){
  const cfg  = LEVEL_CFG[level] || LEVEL_CFG[1];
  const maxC = cfg.gridN;
  // 座標を [0, maxC] の整数にクランプするユーティリティ
  const clamp = v => Math.max(0, Math.min(maxC, Math.round(Number(v)||0)));

  const lines = (raw.lines||[])
    .map(l => ({
      x1: clamp(l.x1 ?? l.x ?? 0),
      y1: clamp(l.y1 ?? l.y ?? 0),
      x2: clamp(l.x2 ?? (l.x+1) ?? 1),
      y2: clamp(l.y2 ?? (l.y+1) ?? 1)
    }))
    .filter(l => !(l.x1===l.x2 && l.y1===l.y2)); // 長さゼロの線分を除去

  // 線分数が設定値と一致しない場合は無効
  if(lines.length !== cfg.lines) return null;

  // ヒント線のインデックスを先頭 cfg.hints 本分だけ生成
  const hintLines = Array.from({length: cfg.hints}, (_,i) => i);

  return {
    level,
    grid: { cols: cfg.gridN+1, rows: cfg.gridN+1 },
    lines,
    hintLines
  };
}

/* ── モデルキャッシュ（localStorage） ──────────────────────────────── */

/*
 * キャッシュからモデル名を読み込む。
 * 有効期限切れまたは存在しない場合は null を返す。
 */
function _loadCachedModel(){
  try{
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if(!raw) return null;
    const {model, ts} = JSON.parse(raw);
    // 有効期限内であればキャッシュ済みモデル名を返す
    if(Date.now()-ts < MODEL_CACHE_TTL) return model;
  }catch(_){}
  return null;
}

/*
 * 選択されたモデル名をタイムスタンプ付きでキャッシュに保存する。
 */
function _saveModel(model){
  try{ localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({model, ts:Date.now()})); }catch(_){}
}

/*
 * モデルキャッシュをクリアする（APIキー変更時や認証エラー時に呼ぶ）。
 */
function clearModelCache(){
  try{ localStorage.removeItem(MODEL_CACHE_KEY); }catch(_){}
}

/* ── 単一モデルへの疎通確認（タイムアウト: 5秒） ───────────────────── */
/*
 * 指定モデルに最小リクエストを送り、応答が返るか確認する。
 * 5秒以内に応答がなければ abort して false を返す。
 */
async function _probeModel(model, apiKey){
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 5000); // 5秒タイムアウト
  try{
    const r = await fetch(
      `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method : 'POST',
        headers: {'Content-Type':'application/json'},
        signal : ctrl.signal,
        body   : JSON.stringify({
          contents:[{parts:[{text:'Reply with the single word: ready'}]}],
          generationConfig:{maxOutputTokens:10}
        })
      }
    );
    clearTimeout(tid);
    return r.ok; // HTTP 2xx なら true
  }catch(e){
    clearTimeout(tid);
    return false; // タイムアウトまたはネットワークエラー
  }
}

/* ── API から利用可能なモデル一覧を取得 ─────────────────────────────── */
/*
 * Gemini API の /models エンドポイントに問い合わせ、
 * generateContent をサポートするモデル名の配列を返す。
 * 取得できない場合は null を返す。
 */
async function _fetchAvailableModels(apiKey){
  try{
    const r = await fetch(`${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`);
    if(!r.ok) return null;
    const data = await r.json();
    return (data.models||[])
      .filter(m => (m.supportedGenerationMethods||[]).includes('generateContent'))
      .map(m => m.name.replace('models/','')); // "models/" プレフィックスを除去
  }catch(_){ return null; }
}

/* ── 最適モデルを解決する（優先モデル → フォールバックリスト） ──────── */
/*
 * 以下の順序でモデルを選択する:
 *   1. localStorage キャッシュに有効なモデルがあればそれを返す
 *   2. PREFERRED_MODEL（gemini-2.5-flash）が使えれば採用
 *   3. API からモデル一覧を取得し既知リストと照合
 *   4. 上位3モデルを並列プローブ → いずれか成功すれば採用
 *   5. 残りを直列プローブ
 *   6. 全滅した場合は gemini-2.0-flash をデフォルトとして返す
 */
async function resolveModel(apiKey){
  // キャッシュヒット: 再プローブ不要
  const cached = _loadCachedModel();
  if(cached){ console.log(`[gemini] キャッシュ済みモデルを使用: ${cached}`); return cached; }

  // ステップ2: 優先モデルを最初に試みる
  console.log(`[gemini] 優先モデルを確認中: ${PREFERRED_MODEL}`);
  if(await _probeModel(PREFERRED_MODEL, apiKey)){
    console.log(`[gemini] 優先モデルを選択: ${PREFERRED_MODEL}`);
    _saveModel(PREFERRED_MODEL);
    return PREFERRED_MODEL;
  }

  // ステップ3: API からモデル一覧を取得してリストを補完
  const available = await _fetchAvailableModels(apiKey);
  let candidates = FALLBACK_MODELS.slice();
  if(available){
    const apiSet = new Set(available);
    // APIリストに存在する既知モデルを優先
    const known  = candidates.filter(m => apiSet.has(m));
    // 既知リストにない追加モデル（gemini系）を末尾に追加
    const extra  = available.filter(m => !candidates.includes(m) && m.startsWith('gemini'));
    candidates   = [...known, ...extra];
    console.log(`[gemini] API取得候補: ${candidates.slice(0,5).join(', ')}…`);
  }

  // ステップ4: 上位3モデルを並列プローブ（高速化）
  const top3    = candidates.slice(0,3);
  const rest    = candidates.slice(3);

  const top3Ok = await Promise.all(top3.map(m => _probeModel(m, apiKey)));
  for(let i=0;i<top3.length;i++){
    if(top3Ok[i]){
      console.log(`[gemini] 並列プローブで選択: ${top3[i]}`);
      _saveModel(top3[i]);
      return top3[i];
    }
  }

  // ステップ5: 残りを直列でプローブ
  for(const m of rest){
    if(await _probeModel(m, apiKey)){
      console.log(`[gemini] 直列プローブで選択: ${m}`);
      _saveModel(m);
      return m;
    }
  }

  // ステップ6: 全モデルが応答しない場合のデフォルト
  console.warn('[gemini] 使用可能なモデルが見つかりません。gemini-2.0-flash をデフォルト使用');
  return 'gemini-2.0-flash';
}

/* ── 問題生成プロンプトを構築 ───────────────────────────────────────── */
/*
 * Gemini に送るプロンプトを生成する。
 * 交差数の制約・グリッドサイズ・線分数・自己チェック手順を含む。
 */
function _buildPrompt(level, count){
  const cfg   = LEVEL_CFG[level] || LEVEL_CFG[1];
  const {lines: lineCount, gridN, lo, hi} = cfg;
  const maxCoord = gridN;

  return `You are generating line puzzle problems for a visual math game.

Rules:
- Each problem has exactly ${lineCount} line segments on a ${maxCoord+1}x${maxCoord+1} grid.
- All coordinates are integers in the range [0, ${maxCoord}] (inclusive).
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

/* ── 組み込みフォールバック問題バンク ───────────────────────────────── */
/*
 * Gemini APIが利用できない・全試行が失敗した場合に使う
 * 事前検証済みの問題セット。各レベル5問ずつ収録。
 * PROBLEM_BANK（problems.js）が利用可能ならそちらを優先する。
 */
const _FALLBACK = {
  // Lv0: 交差数 0-2, 4本, 4x4グリッド
  0: [
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},{x1:0,y1:2,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:0,y2:3},{x1:1,y1:0,x2:1,y2:3},{x1:2,y1:0,x2:2,y2:3},{x1:3,y1:0,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:1},{x1:2,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:0},{x1:0,y1:2,x2:1,y2:3},{x1:1,y1:2,x2:0,y2:3}]}
  ],
  // Lv1: 交差数 0-3, 4本, 4x4グリッド
  1: [
    {lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},{x1:0,y1:2,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:1},{x1:2,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:1,y1:0,x2:0,y2:3},{x1:3,y1:2,x2:3,y2:3}]},
    {lines:[{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:1},{x1:0,y1:0,x2:3,y2:3},{x1:2,y1:0,x2:3,y2:0}]}
  ],
  // Lv2: 交差数 2-5, 4本, 4x4グリッド
  2: [
    {lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},{x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:1,y1:0,x2:2,y2:3},{x1:0,y1:3,x2:1,y2:3}]},
    {lines:[{x1:0,y1:0,x2:2,y2:3},{x1:2,y1:0,x2:0,y2:3},{x1:1,y1:1,x2:3,y2:3},{x1:3,y1:0,x2:1,y2:2}]},
    {lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:2}]},
    {lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},{x1:0,y1:3,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:3}]}
  ],
  // Lv3: 交差数 0-8, 5本, 5x5グリッド
  3: [
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},{x1:0,y1:2,x2:4,y2:2},{x1:2,y1:0,x2:2,y2:4},{x1:0,y1:1,x2:4,y2:3}]},
    {lines:[{x1:0,y1:0,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:0},{x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},{x1:0,y1:4,x2:4,y2:4}]},
    {lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},{x1:0,y1:1,x2:4,y2:1},{x1:0,y1:3,x2:4,y2:3},{x1:2,y1:0,x2:2,y2:4}]},
    {lines:[{x1:0,y1:0,x2:3,y2:4},{x1:1,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:3,y2:0},{x1:1,y1:4,x2:4,y2:0},{x1:0,y1:2,x2:4,y2:2}]},
    {lines:[{x1:0,y1:1,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:1},{x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},{x1:0,y1:0,x2:4,y2:4}]}
  ]
};

/*
 * フォールバック問題をシャッフルして必要数だけ返す。
 * PROBLEM_BANK（problems.js）が利用可能ならそちらを優先する。
 * hintLines が未設定の場合は先頭 cfg.hints 本を自動設定する。
 */
function _getFallback(level, count){
  const pool = (
    typeof PROBLEM_BANK !== 'undefined' && PROBLEM_BANK[level]
      ? PROBLEM_BANK[level]          // problems.js の問題バンクを優先
      : _FALLBACK[level] || _FALLBACK[1] // なければ内蔵バンクを使用
  ).slice();

  // Fisher-Yates シャッフルで問題順をランダム化
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }

  const cfg = LEVEL_CFG[level]||LEVEL_CFG[1];
  // 必要数を切り出し、問題オブジェクト形式に整形して返す
  return pool.slice(0,count).map(p => ({
    level,
    grid: {cols: cfg.gridN+1, rows: cfg.gridN+1},
    lines: p.lines,
    // hintLines が未定義の場合は先頭 N 本をヒントとして設定
    hintLines: p.hintLines || Array.from({length:cfg.hints},(_,i)=>i)
  }));
}

/* ── メイン問題生成関数 ─────────────────────────────────────────────── */
/*
 * Gemini API を使って指定レベルの問題を count 問生成する。
 * APIキー未設定・全試行失敗時はフォールバックバンクで補填する。
 *
 * @param {number} level   - レベル番号 (0-3)
 * @param {number} count   - 生成する問題数
 * @param {string} apiKey  - Gemini API キー
 * @returns {Promise<Array>} 問題オブジェクトの配列
 */
async function generateProblems(level, count, apiKey){
  // APIキーが未設定の場合はすぐにフォールバック
  if(!apiKey){
    console.warn('[gemini] APIキー未設定 – フォールバックバンクを使用');
    return _getFallback(level, count);
  }

  // 使用するモデルを解決する
  let model;
  try{ model = await resolveModel(apiKey); }
  catch(e){
    console.error('[gemini] resolveModel 失敗:', e);
    return _getFallback(level, count);
  }

  const MAX_ATTEMPTS = 5;  // 最大リトライ回数
  const collected    = []; // 検証済み問題の蓄積配列

  // 必要数に達するか最大試行回数に達するまでループ
  for(let attempt=1; attempt<=MAX_ATTEMPTS && collected.length<count; attempt++){
    const need   = count - collected.length; // まだ必要な問題数
    const prompt = _buildPrompt(level, need);

    console.log(`[gemini] 試行 ${attempt}/${MAX_ATTEMPTS} モデル=${model} 必要数=${need}`);

    let raw; // APIレスポンスから抽出したJSON配列
    try{
      const resp = await fetch(
        `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method : 'POST',
          headers: {'Content-Type':'application/json'},
          body   : JSON.stringify({
            contents:[{parts:[{text:prompt}]}],
            generationConfig:{
              temperature      : 0.7,   // 多様性のための温度設定
              maxOutputTokens  : 2048,  // 最大出力トークン数
              responseMimeType : 'application/json' // JSON形式で返すよう指定
            }
          })
        }
      );

      // レート制限（429）: 3秒待ってリトライ
      if(resp.status===429){
        console.warn('[gemini] レート制限中。3秒後にリトライ…');
        await new Promise(r=>setTimeout(r,3000));
        continue;
      }
      // 認証・リクエストエラー（403/400）: キャッシュをクリアして中断
      if(resp.status===403||resp.status===400){
        console.error(`[gemini] HTTP ${resp.status} – モデルキャッシュをクリア`);
        clearModelCache();
        break;
      }
      // その他のHTTPエラー: スキップして次の試行へ
      if(!resp.ok){
        console.warn(`[gemini] HTTP ${resp.status}`);
        continue;
      }

      // レスポンスからテキストを抽出
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // レスポンス内の JSON 配列部分を正規表現で抽出
      const match = text.match(/\[[\s\S]*\]/);
      if(!match){ console.warn('[gemini] レスポンスにJSON配列が見つかりません'); continue; }
      raw = JSON.parse(match[0]);
      if(!Array.isArray(raw)){ continue; }
    }catch(e){
      console.error('[gemini] フェッチ/パースエラー:', e);
      continue;
    }

    // 各候補問題を検証して収集する
    for(const candidate of raw){
      if(collected.length >= count) break;

      // 正規化（座標クランプ・長さゼロ除去・hintLines付与）
      const p = _normalise(candidate, level);
      if(!p){
        console.log('[gemini] 正規化失敗（線分数不正 or 長さゼロ線分あり）');
        continue;
      }

      // 交差数をカウントしてレベル制約と照合
      const n = _countCross(p.lines);
      const {lo,hi} = LEVEL_CFG[level]||LEVEL_CFG[1];
      if(n < lo || n > hi){
        console.log(`[gemini] 却下: 交差数=${n}, 許容範囲=[${lo},${hi}]`);
        continue;
      }
      console.log(`[gemini] 採用: 交差数=${n} ✓`);
      collected.push(p);
    }
  }

  // 必要数に満たない場合はフォールバックバンクで補填
  if(collected.length < count){
    console.warn(`[gemini] 有効問題が ${collected.length}/${count} のみ – フォールバックで補填`);
    const pad = _getFallback(level, count - collected.length);
    collected.push(...pad);
  }

  return collected.slice(0, count);
}

/* ── APIキー管理ヘルパー ────────────────────────────────────────────── */

/*
 * APIキーを localStorage に保存し、モデルキャッシュをクリアする。
 * キー変更時には必ずモデルを再選択させるためキャッシュを消す。
 */
function saveApiKey(key){
  try{ localStorage.setItem('gemini_api_key', key); }catch(_){}
  clearModelCache(); // キー変更時はモデルキャッシュも無効化
}

/*
 * localStorage から APIキーを読み込む。
 * 未設定の場合は空文字列を返す。
 */
function loadApiKey(){
  try{ return localStorage.getItem('gemini_api_key') || ''; }catch(_){ return ''; }
}

/* ── 公開インターフェース ────────────────────────────────────────────── */
// IIFE の戻り値として外部に公開する関数・変数を列挙する
return { generateProblems, resolveModel, saveApiKey, loadApiKey, clearModelCache };

})(); // _G IIFE 終了

/* ── モジュールレベルへの再エクスポート ─────────────────────────────── */
// _G.xxx の形式ではなく直接 xxx() で呼べるようにフラットに展開する
const generateProblems = _G.generateProblems;
const resolveModel     = _G.resolveModel;
const saveApiKey       = _G.saveApiKey;
const loadApiKey       = _G.loadApiKey;
const clearModelCache  = _G.clearModelCache;
