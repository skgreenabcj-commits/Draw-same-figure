/**
 * canvas.js  v2.1
 * キャンバス描画・タッチ／マウス入力の管理
 *
 * 【Bug #3 修正対応】
 * drawAnswer() が受け取る problem.hintLines は、problems.js の
 * getProblems() / gemini.js の _getFallback() によって
 * {x1, y1, x2, y2} 形式の線分オブジェクト配列として渡される。
 * このファイル自体への変更はないが、hintLines の型が正しくなったことで
 * drawLine() / drawEndpoints() への受け渡しが正常に動作するようになった。
 */

/* ============================================================
   内部状態オブジェクト
   ============================================================ */
/**
 * CanvasState: キャンバスモジュール全体で共有する描画・操作状態。
 *
 * userLines  : ユーザーが現在の問題で引いた線分の配列 [{x1,y1,x2,y2},...]
 * dragging   : ドラッグ操作の進行中フラグ
 * startPt    : ドラッグ開始時のグリッド座標 {col, row}
 * currentPt  : 現在のポインタのピクセル座標 {x, y}
 * problem    : 現在表示中の問題オブジェクト（initCanvases で設定）
 */
const CanvasState = {
  userLines:  [],
  dragging:   false,
  startPt:    null,
  currentPt:  null,
  problem:    null
};

/* ============================================================
   描画定数
   ============================================================ */
const DOT_RADIUS         = 5;       // グリッド点の半径（px）
const SNAP_RADIUS        = 0.4;     // スナップ判定半径（グリッドステップの倍率）
const LINE_WIDTH         = 3;       // 標準線幅（px）
const MODEL_COLOR        = '#1A73E8'; // 見本キャンバスの線色（Googleブルー）
const HINT_COLOR         = '#1A73E8'; // ヒント線の色（見本と同色）
const USER_COLOR         = '#FF6B6B'; // ユーザー線の色（コーラルレッド）
const CORRECT_LINE_COLOR = '#22BB55'; // 不正解フィードバック時の正解線色（グリーン）
const DOT_COLOR          = '#AACCEE'; // グリッド点の色（薄い青灰）
const BG_COLOR           = '#F8FBFF'; // キャンバス背景色（極薄ブルー）

/* ============================================================
   グリッドヘッダー用定数
   ============================================================ */
// Lv0–Lv2（4×4グリッド）用の行・列ラベル
const ROW_ANIMALS_4 = ['🐶', '🐱', '🐰', '🐻'];
const ROW_ANIMALS_5 = ['🐶', '🐱', '🐰', '🐻', '🐼'];
const COL_NUMBERS_4 = ['１', '２', '３', '４'];
const COL_NUMBERS_5 = ['１', '２', '３', '４', '５'];

/* ============================================================
   公開: グリッドヘッダーを DOM に構築する
   ============================================================ */
/**
 * 問題のグリッドに対応した行・列ヘッダーを DOM に生成する。
 * Lv3（5×5グリッド）ではヘッダーを非表示にする。
 *
 * @param {Object} problem - 現在の問題オブジェクト
 */
function buildGridHeaders(problem) {
  // Lv3 はヘッダーを表示しない
  const showHeader = problem.level <= 2;
  const cols       = problem.grid.cols;
  const rows       = problem.grid.rows;

  // グリッドサイズに応じてラベル配列を選択
  const animals = rows === 5 ? ROW_ANIMALS_5 : ROW_ANIMALS_4;
  const numbers = cols === 5 ? COL_NUMBERS_5 : COL_NUMBERS_4;

  // 見本側・回答側の両パネルに同じヘッダーを構築
  ['model', 'answer'].forEach(side => {
    const colHeaderEl = document.getElementById(`col-header-${side}`);
    const rowHeaderEl = document.getElementById(`row-header-${side}`);
    if (!colHeaderEl || !rowHeaderEl) return;

    if (!showHeader) {
      // Lv3: ヘッダー要素を非表示にして処理終了
      colHeaderEl.style.display = 'none';
      rowHeaderEl.style.display = 'none';
      return;
    }

    // ヘッダーを表示状態にする
    colHeaderEl.style.display = 'flex';
    rowHeaderEl.style.display = 'flex';

    // ── 列ヘッダー（数字ラベル）を再構築 ──
    colHeaderEl.innerHTML = '';
    numbers.forEach(num => {
      const cell       = document.createElement('div');
      cell.className   = 'col-header-cell';
      cell.textContent = num;
      colHeaderEl.appendChild(cell);
    });

    // ── 行ヘッダー（動物絵文字）を再構築 ──
    rowHeaderEl.innerHTML = '';
    animals.forEach(animal => {
      const cell       = document.createElement('div');
      cell.className   = 'row-header-cell';
      cell.textContent = animal;
      rowHeaderEl.appendChild(cell);
    });
  });
}

/* ============================================================
   行ヘッダーの高さ・フォントをキャンバス実サイズに同期する
   ============================================================ */
/**
 * 行ヘッダー（動物絵文字）の各セルの高さとフォントサイズを
 * キャンバス実サイズに合わせて JS インラインスタイルで設定する。
 * CSS だけでは ResizeObserver 後の再レンダリングに追従しきれないため
 * JS で強制的に上書きする。
 *
 * @param {string} side - 'model' または 'answer'
 * @param {number} rows - グリッドの行数
 */
function syncRowHeaderHeight(side, rows) {
  // キャンバスの包含要素を取得してサイズを計算
  const wrap = document.querySelector(
    side === 'model'
      ? '#grid-outer-model .canvas-wrap'
      : '#grid-outer-answer .canvas-wrap'
  );
  const rowHeaderEl = document.getElementById(`row-header-${side}`);
  if (!wrap || !rowHeaderEl) return;

  // キャンバスの実際の表示幅を取得（getBoundingClientRect 優先）
  const canvasSize = wrap.getBoundingClientRect().width || wrap.offsetWidth || 200;
  const cellH      = canvasSize / rows; // 1セルの高さ

  // CSS 変数 --header-size を読み取りフォントサイズを比例計算
  const headerSize = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--header-size')
  ) || 56;

  // 各行ヘッダーセルにスタイルを適用
  Array.from(rowHeaderEl.children).forEach(cell => {
    cell.style.height     = cellH + 'px';
    cell.style.minHeight  = cellH + 'px';
    cell.style.lineHeight = cellH + 'px';
    // フォントサイズは headerSize の 60%（最小 16px）
    cell.style.fontSize   = Math.max(Math.round(headerSize * 0.60), 16) + 'px';
  });
}

/**
 * 列ヘッダー（数字ラベル）のフォントサイズを JS で同期する。
 *
 * @param {string} side - 'model' または 'answer'
 */
function syncColHeaderFontSize(side) {
  const colHeaderEl = document.getElementById(`col-header-${side}`);
  if (!colHeaderEl) return;

  const headerSize = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--header-size')
  ) || 56;

  // 各列ヘッダーセルにスタイルを適用
  Array.from(colHeaderEl.children).forEach(cell => {
    // フォントサイズは headerSize の 50%（最小 12px）
    cell.style.fontSize   = Math.max(Math.round(headerSize * 0.50), 12) + 'px';
    cell.style.lineHeight = headerSize + 'px';
  });
}

/* ============================================================
   ユーティリティ関数
   ============================================================ */

/**
 * キャンバスを包含要素の実サイズに合わせてリサイズし、
 * デバイスピクセル比（DPR）を考慮したスケールを設定する。
 * 描画前に必ず呼び出すことで Retina 等の高解像度ディスプレイでも
 * 鮮明な描画を維持する。
 *
 * @param {HTMLCanvasElement} canvas - 対象のキャンバス要素
 * @returns {number} CSS ピクセル単位のキャンバスサイズ（幅＝高さ）
 */
function resizeCanvas(canvas) {
  const wrap = canvas.parentElement;
  if (!wrap) return 300;

  // CSS ピクセル単位のサイズを取得（getBoundingClientRect を優先）
  let size = wrap.getBoundingClientRect().width;
  if (!size || size < 10) size = wrap.offsetWidth || 300;

  const dpr          = window.devicePixelRatio || 1;
  const physicalSize = Math.round(size * dpr); // 物理ピクセル単位のサイズ

  // サイズが変わった場合のみ canvas の内部解像度を更新（余計な再描画を避ける）
  if (canvas.width !== physicalSize || canvas.height !== physicalSize) {
    canvas.width  = physicalSize;
    canvas.height = physicalSize;
  }

  // 変換行列をリセットしてから DPR スケールを適用
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  return size; // CSS ピクセル単位のサイズを返す（描画計算に使用）
}

/**
 * グリッドのジオメトリ（余白・ステップ幅）を計算する。
 * 余白は全方向均一で、キャンバスサイズの 12% とする。
 *
 * @param {number} size - CSS ピクセル単位のキャンバスサイズ
 * @param {Object} grid - {cols, rows} グリッドの列数・行数
 * @returns {{pad:number, stepX:number, stepY:number, size:number}}
 */
function calcGrid(size, grid) {
  const PAD   = size * 0.12; // 上下左右の余白
  const inner = size - PAD * 2;
  const stepX = inner / (grid.cols - 1); // 列間の間隔
  const stepY = inner / (grid.rows - 1); // 行間の間隔
  return { pad: PAD, stepX, stepY, size };
}

/**
 * グリッド座標（列・行インデックス）をキャンバスのピクセル座標に変換する。
 *
 * @param {Object} g   - calcGrid() の戻り値
 * @param {number} col - 列インデックス（0 始まり）
 * @param {number} row - 行インデックス（0 始まり）
 * @returns {{x:number, y:number}} キャンバス上のピクセル座標
 */
function dotPos(g, col, row) {
  return {
    x: g.pad + col * g.stepX,
    y: g.pad + row * g.stepY
  };
}

/**
 * ポインタのピクセル座標を最近傍のグリッド点にスナップする。
 * スナップ半径（SNAP_RADIUS × グリッドステップ）内に点がなければ null を返す。
 *
 * @param {Object} g  - calcGrid() の戻り値
 * @param {number} px - ポインタのX座標（CSS px）
 * @param {number} py - ポインタのY座標（CSS px）
 * @returns {{col:number, row:number}|null} スナップされたグリッド座標、またはnull
 */
function snapToGrid(g, px, py) {
  const grid = CanvasState.problem.grid;
  let bestDist = Infinity, bestCol = -1, bestRow = -1;

  // 全グリッド点との距離を計算して最近傍を探す
  for (let c = 0; c < grid.cols; c++) {
    for (let r = 0; r < grid.rows; r++) {
      const p = dotPos(g, c, r);
      const d = Math.hypot(px - p.x, py - p.y);
      if (d < bestDist) { bestDist = d; bestCol = c; bestRow = r; }
    }
  }

  // スナップ半径の計算（X/Yステップの小さい方を基準）
  const threshold = Math.min(g.stepX, g.stepY) * SNAP_RADIUS;
  return bestDist <= threshold ? { col: bestCol, row: bestRow } : null;
}

/* ============================================================
   描画ヘルパー関数（内部使用）
   ============================================================ */

/**
 * キャンバスの背景を塗りつぶす。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size - CSS px のキャンバスサイズ
 */
function drawBackground(ctx, size) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, size, size);
}

/**
 * グリッドの全点を描画する。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} g    - calcGrid() の戻り値
 * @param {Object} grid - {cols, rows}
 */
function drawDots(ctx, g, grid) {
  for (let c = 0; c < grid.cols; c++) {
    for (let r = 0; r < grid.rows; r++) {
      const p = dotPos(g, c, r);
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = DOT_COLOR;
      ctx.fill();
    }
  }
}

/**
 * 単一の線分を描画する。
 *
 * offsetX/offsetY は不正解フィードバック表示時に
 * ユーザー線を正解線からずらして重なりを見やすくするために使用する。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} g      - calcGrid() の戻り値
 * @param {Object} line   - {x1, y1, x2, y2} 線分オブジェクト
 * @param {string} color  - 線の色
 * @param {number} width  - 線幅（px）
 * @param {boolean} dashed - 破線にするか
 * @param {number} [offsetX=0] - X方向オフセット（px）
 * @param {number} [offsetY=0] - Y方向オフセット（px）
 */
function drawLine(ctx, g, line, color, width, dashed, offsetX = 0, offsetY = 0) {
  const p1 = dotPos(g, line.x1, line.y1);
  const p2 = dotPos(g, line.x2, line.y2);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';                         // 線端を丸くして見やすく
  ctx.setLineDash(dashed ? [8, 6] : []);             // 破線パターン
  ctx.beginPath();
  ctx.moveTo(p1.x + offsetX, p1.y + offsetY);
  ctx.lineTo(p2.x + offsetX, p2.y + offsetY);
  ctx.stroke();
  ctx.restore();
}

/**
 * 線分の両端点（始点・終点）を強調円として描画する。
 * グリッド点の上に重ねて線の端を分かりやすくする。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} g      - calcGrid() の戻り値
 * @param {Array}  lines  - 線分オブジェクトの配列
 * @param {string} color  - 端点の色
 * @param {number} [offsetX=0]
 * @param {number} [offsetY=0]
 */
function drawEndpoints(ctx, g, lines, color, offsetX = 0, offsetY = 0) {
  for (const line of lines) {
    // 始点と終点の両方を処理
    for (const pt of [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x + offsetX, p.y + offsetY, DOT_RADIUS + 1, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
}

/**
 * ドラッグ中のプレビュー線（点線）を描画する。
 * ユーザーが指やマウスを動かしている間に仮の線を表示する。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} g       - calcGrid() の戻り値
 * @param {Object} fromDot - スナップされた開始グリッド座標 {col, row}
 * @param {Object} toPx    - 現在のポインタのピクセル座標 {x, y}
 */
function drawPreviewLine(ctx, g, fromDot, toPx) {
  const p1 = dotPos(g, fromDot.col, fromDot.row);
  ctx.save();
  ctx.strokeStyle = USER_COLOR;
  ctx.lineWidth   = LINE_WIDTH;
  ctx.lineCap     = 'round';
  ctx.globalAlpha = 0.6;      // 半透明でプレビューであることを示す
  ctx.setLineDash([6, 5]);    // 点線パターン
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(toPx.x, toPx.y);
  ctx.stroke();
  ctx.restore();
}

/* ============================================================
   ヘッダー同期ヘルパー（内部使用）
   ============================================================ */
/**
 * 見本・回答の両サイドのヘッダーサイズを一括同期する。
 * drawModel() / drawAnswer() の末尾で呼ばれる。
 * Lv3 はヘッダーが存在しないためスキップする。
 *
 * @param {Object} problem - 現在の問題オブジェクト
 */
function syncHeaders(problem) {
  if (problem.level > 2) return; // Lv3 はヘッダーなし
  ['model', 'answer'].forEach(side => {
    syncRowHeaderHeight(side, problem.grid.rows);
    syncColHeaderFontSize(side);
  });
}

/* ============================================================
   公開: 見本キャンバス描画
   ============================================================ */
/**
 * 左パネル（見本）に問題の全線分を描画する。
 * ユーザーが模倣すべき正解の図形を表示する。
 *
 * @param {Object} problem - 現在の問題オブジェクト
 */
function drawModel(problem) {
  const canvas = document.getElementById('canvas-model');
  const size   = resizeCanvas(canvas);         // DPR 対応リサイズ
  const ctx    = canvas.getContext('2d');
  const g      = calcGrid(size, problem.grid); // グリッドジオメトリ計算

  drawBackground(ctx, size);
  drawDots(ctx, g, problem.grid);

  // 全線分を見本色で描画（ヒント線も見本では全表示）
  for (const line of problem.lines) {
    drawLine(ctx, g, line, MODEL_COLOR, LINE_WIDTH + 1, false);
  }
  // 端点を強調して視認性を高める
  drawEndpoints(ctx, g, problem.lines, MODEL_COLOR);

  // ヘッダーのサイズを同期
  syncHeaders(problem);
}

/* ============================================================
   公開: 回答キャンバス描画
   ============================================================ */
/**
 * 右パネル（回答欄）を描画する。
 *
 * 【Bug #3 修正後の動作】
 * problem.hintLines は {x1,y1,x2,y2} 形式のオブジェクト配列であるため
 * drawLine() / drawEndpoints() に直接渡すことができる。
 * 旧版では hintLines が存在しない or 数値配列だったため
 * line.x1 等が undefined になりヒントが描画されていなかった。
 *
 * 描画順: 背景 → グリッド点 → ヒント線（青）→ ユーザー線（赤）
 *
 * @param {Object} problem - 現在の問題オブジェクト
 */
function drawAnswer(problem) {
  const canvas = document.getElementById('canvas-answer');
  const size   = resizeCanvas(canvas);
  const ctx    = canvas.getContext('2d');
  const g      = calcGrid(size, problem.grid);

  drawBackground(ctx, size);
  drawDots(ctx, g, problem.grid);

  // ── ヒント線の描画（見本と同色の濃い青） ──────────────────────────
  // hintLines は線分オブジェクトの配列（Bug #3 修正により正しく渡される）
  // Lv2・Lv3 では hintLines = [] のため何も描画されない
  const hintLines = problem.hintLines || [];
  for (const line of hintLines) {
    drawLine(ctx, g, line, HINT_COLOR, LINE_WIDTH + 1, false);
  }
  // ヒント線の端点を強調
  drawEndpoints(ctx, g, hintLines, HINT_COLOR);

  // ── ユーザーが引いた線の描画（コーラルレッド）────────────────────
  for (const line of CanvasState.userLines) {
    drawLine(ctx, g, line, USER_COLOR, LINE_WIDTH, false);
  }
  // ユーザー線の端点を強調
  drawEndpoints(ctx, g, CanvasState.userLines, USER_COLOR);

  // ヘッダーのサイズを同期
  syncHeaders(problem);
}

/* ============================================================
   オーバーレイ（ドラッグプレビュー）描画
   ============================================================ */
/**
 * 透明なオーバーレイキャンバスにドラッグ中のプレビューを描画する。
 * ドラッグ開始点に強調円を、現在位置まで点線プレビューを表示する。
 *
 * @param {Object} problem - 現在の問題オブジェクト
 * @param {Object|null} toPx - 現在のポインタ位置（ピクセル）
 */
function drawOverlay(problem, toPx) {
  const canvas = document.getElementById('canvas-overlay');
  const size   = resizeCanvas(canvas);
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size); // 前フレームをクリア

  if (!CanvasState.dragging || !CanvasState.startPt) return;

  const g      = calcGrid(size, problem.grid);
  const startP = dotPos(g, CanvasState.startPt.col, CanvasState.startPt.row);

  // ドラッグ開始点に強調円を描く
  ctx.beginPath();
  ctx.arc(startP.x, startP.y, DOT_RADIUS + 4, 0, Math.PI * 2);
  ctx.strokeStyle = USER_COLOR;
  ctx.lineWidth   = 2;
  ctx.stroke();

  // ポインタ位置までプレビュー線を描く
  if (toPx) drawPreviewLine(ctx, g, CanvasState.startPt, toPx);
}

/* ============================================================
   公開: タッチ／マウス操作ハンドラの設定
   ============================================================ */
/**
 * オーバーレイキャンバスにポインタイベントを登録する。
 * 問題切り替え時に古いリスナーが残らないよう、
 * cloneNode で要素ごと置き換えてからリスナーを再登録する。
 *
 * onLineAdded コールバックは線分が追加されるたびに呼ばれる。
 * app.js の loadQuestion() はこのコールバックで線数上限を管理する。
 *
 * @param {Object}   problem     - 現在の問題オブジェクト
 * @param {Function} onLineAdded - 引数: ユーザー線の現在の本数
 */
function setupInteraction(problem, onLineAdded) {
  CanvasState.problem = problem;

  // 古いイベントリスナーを確実に除去するため要素ごと置き換える
  const oldOv = document.getElementById('canvas-overlay');
  const newOv = oldOv.cloneNode(true);
  oldOv.parentNode.replaceChild(newOv, oldOv);
  const ov = document.getElementById('canvas-overlay');

  /**
   * ポインタ位置をキャンバスローカル座標に変換する。
   * タッチイベントとマウスイベントの両方に対応。
   */
  const getPos = (e) => {
    const rect  = ov.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  };

  /** ドラッグ開始: グリッドにスナップできた場合のみ開始 */
  const onStart = (e) => {
    e.preventDefault();
    const pos  = getPos(e);
    const size = ov.getBoundingClientRect().width || ov.offsetWidth || 300;
    const g    = calcGrid(size, problem.grid);
    const snap = snapToGrid(g, pos.x, pos.y);
    if (!snap) return; // グリッド点外ならドラッグ開始しない
    CanvasState.dragging  = true;
    CanvasState.startPt   = snap;
    CanvasState.currentPt = pos;
    drawOverlay(problem, pos);
  };

  /** ドラッグ中: プレビュー線を更新 */
  const onMove = (e) => {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    const pos = getPos(e);
    CanvasState.currentPt = pos;
    drawOverlay(problem, pos);
  };

  /** ドラッグ終了: 終点がグリッド点にスナップできれば線分を確定 */
  const onEnd = (e) => {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    CanvasState.dragging = false;

    // タッチ終了時は changedTouches から座標を取得
    const rect   = ov.getBoundingClientRect();
    const rawPos = e.changedTouches
      ? { x: e.changedTouches[0].clientX - rect.left,
          y: e.changedTouches[0].clientY - rect.top }
      : CanvasState.currentPt;

    // オーバーレイをクリア（プレビュー線を消す）
    const overlayCtx = ov.getContext('2d');
    overlayCtx.clearRect(0, 0, ov.width, ov.height);

    if (!rawPos) return;
    const size    = rect.width || ov.offsetWidth || 300;
    const g       = calcGrid(size, problem.grid);
    const endSnap = snapToGrid(g, rawPos.x, rawPos.y);
    if (!endSnap) return; // 終点がグリッド外ならキャンセル

    const s = CanvasState.startPt;
    // 始点と終点が同じグリッド点なら長さゼロ線分 → スキップ
    if (s.col === endSnap.col && s.row === endSnap.row) return;

    // 線分を確定してユーザーラインに追加
    CanvasState.userLines.push({
      x1: s.col, y1: s.row,
      x2: endSnap.col, y2: endSnap.row
    });

    // 回答キャンバスを再描画（新しい線分を反映）
    drawAnswer(problem);

    // コールバックで現在の線数を通知（app.js が上限管理に使用）
    if (typeof onLineAdded === 'function') onLineAdded(CanvasState.userLines.length);
  };

  // マウスイベントの登録（passive:false で preventDefault() を有効化）
  ov.addEventListener('mousedown',  onStart, { passive: false });
  ov.addEventListener('mousemove',  onMove,  { passive: false });
  ov.addEventListener('mouseup',    onEnd,   { passive: false });
  ov.addEventListener('mouseleave', onEnd,   { passive: false }); // キャンバス外に出たら終了
  // タッチイベントの登録
  ov.addEventListener('touchstart', onStart, { passive: false });
  ov.addEventListener('touchmove',  onMove,  { passive: false });
  ov.addEventListener('touchend',   onEnd,   { passive: false });
}

/* ============================================================
   公開: 回答線の取得・操作
   ============================================================ */
/**
 * 現在ユーザーが引いた線分の配列のコピーを返す。
 * app.js の judgeAnswer() から呼ばれる。
 *
 * @returns {Array<{x1,y1,x2,y2}>}
 */
function getAnswerLines() {
  return [...CanvasState.userLines]; // 浅いコピーを返す（外部から配列を変更させない）
}

/**
 * 最後に引いた線分を1本だけ取り消す（アンドゥ）。
 * ボタン「１つもどす」から呼ばれる。
 */
function undoLastLine() {
  if (CanvasState.userLines.length === 0) return;
  CanvasState.userLines.pop();
  drawAnswer(CanvasState.problem); // 再描画してアンドゥを反映
}

/**
 * ユーザーが引いた全線分を消去する（クリア）。
 * ボタン「ぜんぶけす」から呼ばれる。
 */
function clearAnswerLines() {
  CanvasState.userLines = [];
  if (CanvasState.problem) drawAnswer(CanvasState.problem); // 再描画
}

/* ============================================================
   公開: 不正解フィードバック用キャンバス描画
   ============================================================ */
/**
 * フィードバックオーバーレイ内の小キャンバス（canvas-wrong）に
 * ユーザーの誤答線（薄い赤・オフセット）と正解線（緑・太）を重ねて描画する。
 * 「どこが違ったか」を視覚的に分かりやすく提示する。
 *
 * @param {Object} problem   - 現在の問題オブジェクト
 * @param {Array}  userLines - ユーザーが引いた線分の配列
 */
function drawWrongFeedback(problem, userLines) {
  const canvas = document.getElementById('canvas-wrong');
  const dpr    = window.devicePixelRatio || 1;

  // フィードバックキャンバスのサイズを親要素に合わせて計算（最大280px）
  const parentW = canvas.parentElement
    ? (canvas.parentElement.getBoundingClientRect().width
       || canvas.parentElement.offsetWidth
       || 280)
    : 280;
  const W = Math.min(Math.round(parentW * 0.85), 280);

  // canvas の解像度とスタイルサイズを設定
  canvas.width        = Math.round(W * dpr);
  canvas.height       = Math.round(W * dpr);
  canvas.style.width  = W + 'px';
  canvas.style.height = W + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr); // DPR 適用

  const g = calcGrid(W, problem.grid);
  drawBackground(ctx, W);
  drawDots(ctx, g, problem.grid);

  // ── ユーザーの誤答線（薄い赤・右下にオフセット）──────────────────
  // (4,4)px ずらすことで正解線と重なっても両方見えるようにする
  const OX = 4, OY = 4;
  for (const line of userLines) {
    drawLine(ctx, g, line, '#FF9999', LINE_WIDTH, false, OX, OY);
  }
  // 誤答線の端点
  for (const line of userLines) {
    for (const pt of [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x + OX, p.y + OY, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#FF9999';
      ctx.fill();
    }
  }

  // ── 正解の線（グリーン・太線）──────────────────────────────────────
  for (const line of problem.lines) {
    drawLine(ctx, g, line, CORRECT_LINE_COLOR, LINE_WIDTH + 2, false);
  }
  drawEndpoints(ctx, g, problem.lines, CORRECT_LINE_COLOR);
}

/* ============================================================
   リサイズ対応 — ResizeObserver
   ============================================================ */
/**
 * ResizeObserver を設定してキャンバスの親要素のサイズ変化を監視する。
 * ウィンドウリサイズや画面回転時に自動的に再描画する。
 * ResizeObserver 非対応ブラウザでは window の resize イベントにフォールバック。
 */
function setupResizeObserver() {
  const redraw = () => {
    if (!CanvasState.problem) return; // 問題がロードされていない場合はスキップ
    drawModel(CanvasState.problem);
    drawAnswer(CanvasState.problem);
  };

  if (window.ResizeObserver) {
    // 見本・回答キャンバスの親要素（canvas-wrap）を監視対象にする
    const targets = [
      document.getElementById('canvas-model')?.parentElement,
      document.getElementById('canvas-answer')?.parentElement
    ].filter(Boolean);

    const ro = new ResizeObserver(redraw);
    targets.forEach(el => ro.observe(el));
  } else {
    // フォールバック: ウィンドウリサイズで再描画
    window.addEventListener('resize', redraw);
  }
}

/* ============================================================
   公開: キャンバス初期化（問題切り替え時に呼ぶ）
   ============================================================ */
/**
 * 問題が切り替わるたびに呼ばれ、前の問題の状態をすべてリセットする。
 * setupInteraction() より前に呼ぶ必要がある。
 *
 * @param {Object} problem - 新しい問題オブジェクト
 */
function initCanvases(problem) {
  CanvasState.userLines  = [];    // ユーザー線をリセット
  CanvasState.dragging   = false; // ドラッグ状態をリセット
  CanvasState.startPt    = null;  // 開始点をリセット
  CanvasState.currentPt  = null;  // 現在位置をリセット
  CanvasState.problem    = problem; // 新しい問題を設定
}

// DOMContentLoaded 後に ResizeObserver を開始する
document.addEventListener('DOMContentLoaded', setupResizeObserver);
