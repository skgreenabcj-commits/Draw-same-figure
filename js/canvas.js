/**
 * canvas.js
 * キャンバス描画・タッチ/マウス入力の管理
 *
 * 公開関数:
 *   initCanvases(problem)              - 問題読み込み時に呼ぶ
 *   drawModel(problem)                 - 見本キャンバスを描画
 *   drawAnswer(problem)                - 回答キャンバスを描画（ヒント線含む）
 *   setupInteraction(problem, cb)      - タッチ/マウス操作を設定
 *   getAnswerLines()                   - ユーザーが引いた線を返す
 *   undoLastLine()                     - 最後の1本を取り消す
 *   clearAnswerLines()                 - ユーザー回答をリセット
 *   drawWrongFeedback(canvas, problem, userLines) - 不正解フィードバック描画
 */

/* ============================================================
   内部状態
   ============================================================ */
const CanvasState = {
  userLines: [],   // [{x1,y1,x2,y2}]  グリッド座標
  dragging: false,
  startPt: null,   // {col, row}  スナップ済みグリッド点
  currentPt: null,
  problem: null
};

/* ============================================================
   定数
   ============================================================ */
const DOT_RADIUS   = 5;
const SNAP_RADIUS  = 0.4;  // グリッド間隔の何倍以内でスナップ
const LINE_WIDTH   = 3;
const HINT_WIDTH   = 3;
const CORRECT_COLOR = '#1A73E8';
const HINT_COLOR    = '#93BBF5';
const MODEL_COLOR   = '#1A73E8';
const USER_COLOR    = '#FF6B6B';
const WRONG_COLOR   = '#FF2222';
const DOT_COLOR     = '#AACCEE';
const BG_COLOR      = '#F8FBFF';

/* ============================================================
   ユーティリティ
   ============================================================ */

/** キャンバスの実ピクセルサイズに合わせる（Retina対応） */
function resizeCanvas(canvas) {
  const wrap = canvas.parentElement;
  if (!wrap) return 300;
  // getBoundingClientRect で正確なサイズを取得
  const rect = wrap.getBoundingClientRect();
  const size = Math.max(rect.width || wrap.clientWidth, 100);
  const dpr  = window.devicePixelRatio || 1;
  canvas.width  = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); // リセット
  ctx.scale(dpr, dpr);
  return size;
}

/** グリッド情報を計算する */
function calcGrid(size, grid) {
  const PAD = size * 0.12;
  const inner = size - PAD * 2;
  const stepX = inner / (grid.cols - 1);
  const stepY = inner / (grid.rows - 1);
  return { pad: PAD, stepX, stepY, size };
}

/** グリッド点のピクセル座標 */
function dotPos(g, col, row) {
  return {
    x: g.pad + col * g.stepX,
    y: g.pad + row * g.stepY
  };
}

/** ピクセル座標 → 最近傍グリッド点 (snap) */
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
  if (bestDist <= threshold) return { col: bestCol, row: bestRow };
  return null;
}

/* ============================================================
   描画ヘルパー
   ============================================================ */
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
  if (dashed) ctx.setLineDash([8, 6]);
  else        ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.restore();
}

function drawPreviewLine(ctx, g, fromDot, toPx) {
  const p1 = dotPos(g, fromDot.col, fromDot.row);
  ctx.save();
  ctx.strokeStyle = USER_COLOR;
  ctx.lineWidth   = LINE_WIDTH;
  ctx.lineCap     = 'round';
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(toPx.x, toPx.y);
  ctx.stroke();
  ctx.restore();
}

function drawBackground(ctx, size) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, size, size);
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
  // 端点に塗りつぶし円
  for (const line of problem.lines) {
    for (const pt of [{x:line.x1,y:line.y1},{x:line.x2,y:line.y2}]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS + 1, 0, Math.PI * 2);
      ctx.fillStyle = MODEL_COLOR;
      ctx.fill();
    }
  }
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

  // ヒント線 (Level 1)
  for (const line of problem.hintLines) {
    drawLine(ctx, g, line, HINT_COLOR, HINT_WIDTH + 1, false);
    for (const pt of [{x:line.x1,y:line.y1},{x:line.x2,y:line.y2}]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS + 1, 0, Math.PI * 2);
      ctx.fillStyle = HINT_COLOR;
      ctx.fill();
    }
  }

  // ユーザーが引いた線
  for (const line of CanvasState.userLines) {
    drawLine(ctx, g, line, USER_COLOR, LINE_WIDTH, false);
    for (const pt of [{x:line.x1,y:line.y1},{x:line.x2,y:line.y2}]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS + 1, 0, Math.PI * 2);
      ctx.fillStyle = USER_COLOR;
      ctx.fill();
    }
  }
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
  const g = calcGrid(size, problem.grid);

  // スタート点ハイライト
  const startP = dotPos(g, CanvasState.startPt.col, CanvasState.startPt.row);
  ctx.beginPath();
  ctx.arc(startP.x, startP.y, DOT_RADIUS + 4, 0, Math.PI * 2);
  ctx.strokeStyle = USER_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (toPx) drawPreviewLine(ctx, g, CanvasState.startPt, toPx);
}

/* ============================================================
   公開: タッチ/マウス操作設定
   ============================================================ */
function setupInteraction(problem, onLineAdded) {
  CanvasState.problem = problem;

  const overlay = document.getElementById('canvas-overlay');

  // 既存イベントを除去
  const newOverlay = overlay.cloneNode(true);
  overlay.parentNode.replaceChild(newOverlay, overlay);
  const ov = document.getElementById('canvas-overlay');

  const getCanvasPos = (e) => {
    const rect = ov.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    // CSS pixel
    return {
      x: (clientX - rect.left),
      y: (clientY - rect.top)
    };
  };

  const onStart = (e) => {
    e.preventDefault();
    const pos = getCanvasPos(e);
    const size = ov.getBoundingClientRect().width;
    const g = calcGrid(size, problem.grid);
    const snapped = snapToGrid(g, pos.x, pos.y);
    if (!snapped) return;
    CanvasState.dragging = true;
    CanvasState.startPt  = snapped;
    CanvasState.currentPt = pos;
    drawOverlay(problem, pos);
  };

  const onMove = (e) => {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    const pos = getCanvasPos(e);
    CanvasState.currentPt = pos;
    drawOverlay(problem, pos);
  };

  const onEnd = (e) => {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    CanvasState.dragging = false;

    const rect = ov.getBoundingClientRect();
    const rawPos = e.changedTouches
      ? { x: e.changedTouches[0].clientX - rect.left,
          y: e.changedTouches[0].clientY - rect.top }
      : CanvasState.currentPt;

    const size = rect.width;
    const g = calcGrid(size, problem.grid);
    const endSnap = snapToGrid(g, rawPos.x, rawPos.y);

    // オーバーレイをクリア
    const overlayCanvas = document.getElementById('canvas-overlay');
    const overlayCtx = overlayCanvas.getContext('2d');
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (!endSnap) return;
    const s = CanvasState.startPt;
    // 同じ点はNG
    if (s.col === endSnap.col && s.row === endSnap.row) return;

    const newLine = { x1: s.col, y1: s.row, x2: endSnap.col, y2: endSnap.row };
    CanvasState.userLines.push(newLine);
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
function getAnswerLines() { return [...CanvasState.userLines]; }

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
   ============================================================ */
function drawWrongFeedback(problem, userLines) {
  const canvas = document.getElementById('canvas-wrong');
  const dpr = window.devicePixelRatio || 1;
  const W = 280;
  canvas.width  = W * dpr;
  canvas.height = W * dpr;
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
    for (const pt of [{x:line.x1,y:line.y1},{x:line.x2,y:line.y2}]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS + 2, 0, Math.PI * 2);
      ctx.fillStyle = WRONG_COLOR;
      ctx.fill();
    }
  }
}

/* ============================================================
   リサイズ対応
   ============================================================ */
window.addEventListener('resize', () => {
  if (!CanvasState.problem) return;
  drawModel(CanvasState.problem);
  drawAnswer(CanvasState.problem);
});

/* ============================================================
   初期化 (問題切り替え時)
   ============================================================ */
function initCanvases(problem) {
  CanvasState.userLines  = [];
  CanvasState.dragging   = false;
  CanvasState.startPt    = null;
  CanvasState.currentPt  = null;
  CanvasState.problem    = problem;
}
