/**
 * canvas.js
 * キャンバス描画・タッチ/マウス入力の管理
 *
 * 公開関数:
 *   initCanvases(problem)
 *   drawModel(problem)
 *   drawAnswer(problem)
 *   setupInteraction(problem, cb)
 *   getAnswerLines()
 *   undoLastLine()
 *   clearAnswerLines()
 *   drawWrongFeedback(problem, userLines)
 */

/* ============================================================
   内部状態
   ============================================================ */
const CanvasState = {
  userLines:  [],
  dragging:   false,
  startPt:    null,   // { col, row }
  currentPt:  null,   // { x, y } CSS px
  problem:    null
};

/* ============================================================
   定数
   ============================================================ */
const DOT_RADIUS    = 5;
const SNAP_RADIUS   = 0.4;   // グリッド間隔の何倍以内でスナップ
const LINE_WIDTH    = 3;
const HINT_WIDTH    = 3;
const MODEL_COLOR   = '#1A73E8';
const HINT_COLOR    = '#93BBF5';
const USER_COLOR    = '#FF6B6B';
const WRONG_COLOR   = '#FF2222';
const DOT_COLOR     = '#AACCEE';
const BG_COLOR      = '#F8FBFF';

/* ============================================================
   ユーティリティ
   ============================================================ */

/**
 * キャンバスを親要素のサイズに合わせてリサイズ（Retina 対応）
 * ★ display:none 中でも offsetWidth にフォールバックして
 *    サイズが 0 になるバグを防ぐ
 * @returns {number} CSS ピクセル単位の辺長
 */
function resizeCanvas(canvas) {
  const wrap = canvas.parentElement;
  if (!wrap) return 300;

  // getBoundingClientRect は display:none 時に 0 を返すことがある
  let size = wrap.getBoundingClientRect().width;
  if (!size || size < 10) {
    size = wrap.offsetWidth || 300;
  }

  const dpr          = window.devicePixelRatio || 1;
  const physicalSize = Math.round(size * dpr);

  // サイズが変わった場合のみ再設定（ちらつき防止）
  if (canvas.width !== physicalSize || canvas.height !== physicalSize) {
    canvas.width  = physicalSize;
    canvas.height = physicalSize;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); // 変換行列をリセット
  ctx.scale(dpr, dpr);
  return size;
}

/**
 * グリッドのレイアウト情報を計算する
 * @param {number} size   CSS px 単位のキャンバス辺長
 * @param {{cols,rows}} grid
 */
function calcGrid(size, grid) {
  const PAD   = size * 0.12;
  const inner = size - PAD * 2;
  const stepX = inner / (grid.cols - 1);
  const stepY = inner / (grid.rows - 1);
  return { pad: PAD, stepX, stepY, size };
}

/**
 * グリッド点 (col, row) の CSS px 座標を返す
 */
function dotPos(g, col, row) {
  return {
    x: g.pad + col * g.stepX,
    y: g.pad + row * g.stepY
  };
}

/**
 * CSS px 座標を最近傍グリッド点にスナップする
 * スナップ圏外なら null を返す
 */
function snapToGrid(g, px, py) {
  const grid = CanvasState.problem.grid;
  let bestDist = Infinity, bestCol = -1, bestRow = -1;

  for (let c = 0; c < grid.cols; c++) {
    for (let r = 0; r < grid.rows; r++) {
      const p = dotPos(g, c, r);
      const d = Math.hypot(px - p.x, py - p.y);
      if (d < bestDist) { bestDist = d; bestCol = c; bestRow = r; }
    }
  }

  const threshold = Math.min(g.stepX, g.stepY) * SNAP_RADIUS;
  return bestDist <= threshold ? { col: bestCol, row: bestRow } : null;
}

/* ============================================================
   描画ヘルパー
   ============================================================ */

function drawBackground(ctx, size) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, size, size);
}

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

function drawLine(ctx, g, line, color, width, dashed) {
  const p1 = dotPos(g, line.x1, line.y1);
  const p2 = dotPos(g, line.x2, line.y2);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.setLineDash(dashed ? [8, 6] : []);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.restore();
}

function drawEndpoints(ctx, g, lines, color) {
  for (const line of lines) {
    for (const pt of [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS + 1, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
}

function drawPreviewLine(ctx, g, fromDot, toPx) {
  const p1 = dotPos(g, fromDot.col, fromDot.row);
  ctx.save();
  ctx.strokeStyle  = USER_COLOR;
  ctx.lineWidth    = LINE_WIDTH;
  ctx.lineCap      = 'round';
  ctx.globalAlpha  = 0.6;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(toPx.x, toPx.y);
  ctx.stroke();
  ctx.restore();
}

/* ============================================================
   公開: 見本描画
   ============================================================ */
function drawModel(problem) {
  const canvas = document.getElementById('canvas-model');
  const size   = resizeCanvas(canvas);
  const ctx    = canvas.getContext('2d');
  const g      = calcGrid(size, problem.grid);

  drawBackground(ctx, size);
  drawDots(ctx, g, problem.grid);

  for (const line of problem.lines) {
    drawLine(ctx, g, line, MODEL_COLOR, LINE_WIDTH + 1, false);
  }
  drawEndpoints(ctx, g, problem.lines, MODEL_COLOR);
}

/* ============================================================
   公開: 回答キャンバス描画
   ============================================================ */
function drawAnswer(problem) {
  const canvas = document.getElementById('canvas-answer');
  const size   = resizeCanvas(canvas);
  const ctx    = canvas.getContext('2d');
  const g      = calcGrid(size, problem.grid);

  drawBackground(ctx, size);
  drawDots(ctx, g, problem.grid);

  // ヒント線（Level 1）
  for (const line of (problem.hintLines || [])) {
    drawLine(ctx, g, line, HINT_COLOR, HINT_WIDTH + 1, false);
  }
  drawEndpoints(ctx, g, problem.hintLines || [], HINT_COLOR);

  // ユーザーが引いた線
  for (const line of CanvasState.userLines) {
    drawLine(ctx, g, line, USER_COLOR, LINE_WIDTH, false);
  }
  drawEndpoints(ctx, g, CanvasState.userLines, USER_COLOR);
}

/* ============================================================
   オーバーレイ（プレビュー）描画
   ============================================================ */
function drawOverlay(problem, toPx) {
  const canvas = document.getElementById('canvas-overlay');
  const size   = resizeCanvas(canvas);
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  if (!CanvasState.dragging || !CanvasState.startPt) return;

  const g      = calcGrid(size, problem.grid);
  const startP = dotPos(g, CanvasState.startPt.col, CanvasState.startPt.row);

  // スタート点ハイライト
  ctx.beginPath();
  ctx.arc(startP.x, startP.y, DOT_RADIUS + 4, 0, Math.PI * 2);
  ctx.strokeStyle = USER_COLOR;
  ctx.lineWidth   = 2;
  ctx.stroke();

  if (toPx) drawPreviewLine(ctx, g, CanvasState.startPt, toPx);
}

/* ============================================================
   公開: タッチ/マウス操作設定
   ============================================================ */
function setupInteraction(problem, onLineAdded) {
  CanvasState.problem = problem;

  // 既存イベントをすべて除去するためノードごと置き換える
  const oldOv = document.getElementById('canvas-overlay');
  const newOv = oldOv.cloneNode(true);
  oldOv.parentNode.replaceChild(newOv, oldOv);
  const ov = document.getElementById('canvas-overlay');

  /* ---------- 座標取得 ---------- */
  const getPos = (e) => {
    const rect   = ov.getBoundingClientRect();
    const touch  = e.touches ? e.touches[0] : e;
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  };

  /* ---------- イベントハンドラ ---------- */
  const onStart = (e) => {
    e.preventDefault();
    const pos  = getPos(e);
    const size = ov.getBoundingClientRect().width || ov.offsetWidth || 300;
    const g    = calcGrid(size, problem.grid);
    const snap = snapToGrid(g, pos.x, pos.y);
    if (!snap) return;

    CanvasState.dragging  = true;
    CanvasState.startPt   = snap;
    CanvasState.currentPt = pos;
    drawOverlay(problem, pos);
  };

  const onMove = (e) => {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    const pos = getPos(e);
    CanvasState.currentPt = pos;
    drawOverlay(problem, pos);
  };

  const onEnd = (e) => {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    CanvasState.dragging = false;

    // タッチ終了時は changedTouches から座標を取得
    const rect   = ov.getBoundingClientRect();
    const rawPos = e.changedTouches
      ? {
          x: e.changedTouches[0].clientX - rect.left,
          y: e.changedTouches[0].clientY - rect.top
        }
      : CanvasState.currentPt;

    // オーバーレイをクリア
    const overlayCtx = ov.getContext('2d');
    overlayCtx.clearRect(0, 0, ov.width, ov.height);

    if (!rawPos) return;
    const size   = rect.width || ov.offsetWidth || 300;
    const g      = calcGrid(size, problem.grid);
    const endSnap = snapToGrid(g, rawPos.x, rawPos.y);
    if (!endSnap) return;

    const s = CanvasState.startPt;
    // 同一点は無効
    if (s.col === endSnap.col && s.row === endSnap.row) return;

    CanvasState.userLines.push({
      x1: s.col, y1: s.row,
      x2: endSnap.col, y2: endSnap.row
    });
    drawAnswer(problem);
    if (typeof onLineAdded === 'function') onLineAdded(CanvasState.userLines.length);
  };

  ov.addEventListener('mousedown',  onStart, { passive: false });
  ov.addEventListener('mousemove',  onMove,  { passive: false });
  ov.addEventListener('mouseup',    onEnd,   { passive: false });
  ov.addEventListener('mouseleave', onEnd,   { passive: false });
  ov.addEventListener('touchstart', onStart, { passive: false });
  ov.addEventListener('touchmove',  onMove,  { passive: false });
  ov.addEventListener('touchend',   onEnd,   { passive: false });
}

/* ============================================================
   公開: 回答線の取得・操作
   ============================================================ */
function getAnswerLines()  { return [...CanvasState.userLines]; }

function undoLastLine() {
  if (CanvasState.userLines.length === 0) return;
  CanvasState.userLines.pop();
  drawAnswer(CanvasState.problem);
}

function clearAnswerLines() {
  CanvasState.userLines = [];
  if (CanvasState.problem) drawAnswer(CanvasState.problem);
}

/* ============================================================
   公開: 不正解フィードバック用キャンバス描画
   ★ 親要素の幅に動的に追従する
   ============================================================ */
function drawWrongFeedback(problem, userLines) {
  const canvas = document.getElementById('canvas-wrong');
  const dpr    = window.devicePixelRatio || 1;

  // 親要素の幅を基準にサイズを決める（最大 260px）
  const parentW = canvas.parentElement
    ? (canvas.parentElement.getBoundingClientRect().width
       || canvas.parentElement.offsetWidth
       || 280)
    : 280;
  const W = Math.min(Math.round(parentW * 0.85), 260);

  canvas.width        = Math.round(W * dpr);
  canvas.height       = Math.round(W * dpr);
  canvas.style.width  = W + 'px';
  canvas.style.height = W + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const g = calcGrid(W, problem.grid);

  drawBackground(ctx, W);
  drawDots(ctx, g, problem.grid);

  // ユーザーの線（薄く）
  for (const line of userLines) {
    drawLine(ctx, g, line, '#FFAAAA', 2, false);
  }

  // 正解の線（赤・太）
  for (const line of problem.lines) {
    drawLine(ctx, g, line, WRONG_COLOR, LINE_WIDTH + 1, false);
  }
  drawEndpoints(ctx, g, problem.lines, WRONG_COLOR);
}

/* ============================================================
   リサイズ対応
   ★ ResizeObserver でキャンバス親要素のサイズ変化を監視
     （デバイス回転・ウィンドウリサイズに対応）
   ============================================================ */
function setupResizeObserver() {
  const redraw = () => {
    if (!CanvasState.problem) return;
    drawModel(CanvasState.problem);
    drawAnswer(CanvasState.problem);
  };

  if (window.ResizeObserver) {
    const targets = [
      document.getElementById('canvas-model')?.parentElement,
      document.getElementById('canvas-answer')?.parentElement
    ].filter(Boolean);

    const ro = new ResizeObserver(redraw);
    targets.forEach(el => ro.observe(el));
  } else {
    // ResizeObserver 非対応ブラウザ向けフォールバック
    window.addEventListener('resize', redraw);
  }
}

/* ============================================================
   初期化（問題切り替え時に呼ぶ）
   ============================================================ */
function initCanvases(problem) {
  CanvasState.userLines  = [];
  CanvasState.dragging   = false;
  CanvasState.startPt    = null;
  CanvasState.currentPt  = null;
  CanvasState.problem    = problem;
}

/* ============================================================
   DOM 読み込み後に ResizeObserver を設定
   ============================================================ */
document.addEventListener('DOMContentLoaded', setupResizeObserver);
