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
 *   buildGridHeaders(problem)        ← 追加: ヘッダー DOM を構築
 */

/* ============================================================
   内部状態
   ============================================================ */
const CanvasState = {
  userLines:  [],
  dragging:   false,
  startPt:    null,
  currentPt:  null,
  problem:    null
};

/* ============================================================
   定数
   ============================================================ */
const DOT_RADIUS    = 5;
const SNAP_RADIUS   = 0.4;
const LINE_WIDTH    = 3;
const MODEL_COLOR   = '#1A73E8';
// ★ ヒント線を見本と同色の濃い青に変更
const HINT_COLOR    = '#1A73E8';
const USER_COLOR    = '#FF6B6B';
// ★ 不正解フィードバック: 正解線を緑に変更
const CORRECT_LINE_COLOR = '#22BB55';
const DOT_COLOR     = '#AACCEE';
const BG_COLOR      = '#F8FBFF';

/* ============================================================
   グリッドヘッダー用定数
   ============================================================ */
// 行ヘッダー：動物絵文字（上から順、Lv1/Lv2は4行、Lv3は5行）
const ROW_ANIMALS_4 = ['🐶', '🐱', '🐰', '🐻'];
const ROW_ANIMALS_5 = ['🐶', '🐱', '🐰', '🐻', '🐼'];

// 列ヘッダー：数字（左から順）
const COL_NUMBERS_4 = ['１', '２', '３', '４'];
const COL_NUMBERS_5 = ['１', '２', '３', '４', '５'];

/* ============================================================
   公開: グリッドヘッダーを DOM に構築する
   Lv1/Lv2 のみ表示、Lv3 は非表示
   ============================================================ */
function buildGridHeaders(problem) {
  const showHeader = problem.level <= 2;
  const cols = problem.grid.cols;
  const rows = problem.grid.rows;

  const colAnimals = rows === 5 ? ROW_ANIMALS_5 : ROW_ANIMALS_4;
  const colNumbers = cols === 5 ? COL_NUMBERS_5 : COL_NUMBERS_4;

  ['model', 'answer'].forEach(side => {
    const outerEl    = document.getElementById(`grid-outer-${side}`);
    const colHeaderEl = document.getElementById(`col-header-${side}`);
    const rowHeaderEl = document.getElementById(`row-header-${side}`);

    if (!outerEl || !colHeaderEl || !rowHeaderEl) return;

    if (!showHeader) {
      // Lv3: ヘッダーを非表示にし、canvas-wrap を直接表示
      colHeaderEl.style.display = 'none';
      rowHeaderEl.style.display = 'none';
      return;
    }

    // ヘッダーを表示
    colHeaderEl.style.display = 'flex';
    rowHeaderEl.style.display = 'flex';

    // ---- 列ヘッダー（数字）を構築 ----
    colHeaderEl.innerHTML = '';
    colNumbers.forEach(num => {
      const cell = document.createElement('div');
      cell.className = 'col-header-cell';
      cell.textContent = num;
      colHeaderEl.appendChild(cell);
    });

    // ---- 行ヘッダー（動物）を構築 ----
    rowHeaderEl.innerHTML = '';
    colAnimals.forEach(animal => {
      const cell = document.createElement('div');
      cell.className = 'row-header-cell';
      cell.textContent = animal;
      rowHeaderEl.appendChild(cell);
    });

    // ---- row-header の高さをキャンバスに同期 ----
    // canvas-wrap の aspect-ratio:1/1 のため、幅 = 高さ
    // 各 cell の高さをキャンバス幅 / rows で設定
    syncRowHeaderHeight(side, rows);
  });
}

/**
 * 行ヘッダーの各セルの高さを canvas-wrap の実サイズに合わせる
 * ResizeObserver から再呼び出しされる
 */
function syncRowHeaderHeight(side, rows) {
  const wrap = document.querySelector(
    side === 'model' ? '#grid-outer-model .canvas-wrap'
                     : '#grid-outer-answer .canvas-wrap'
  );
  const rowHeaderEl = document.getElementById(`row-header-${side}`);
  if (!wrap || !rowHeaderEl) return;

  const canvasSize = wrap.getBoundingClientRect().width || wrap.offsetWidth || 200;
  const cellH = canvasSize / rows;

  Array.from(rowHeaderEl.children).forEach(cell => {
    cell.style.height = cellH + 'px';
    cell.style.minHeight = cellH + 'px';
  });
}

/* ============================================================
   ユーティリティ
   ============================================================ */

/**
 * キャンバスを親要素のサイズに合わせてリサイズ（Retina 対応）
 */
function resizeCanvas(canvas) {
  const wrap = canvas.parentElement;
  if (!wrap) return 300;

  let size = wrap.getBoundingClientRect().width;
  if (!size || size < 10) size = wrap.offsetWidth || 300;

  const dpr          = window.devicePixelRatio || 1;
  const physicalSize = Math.round(size * dpr);

  if (canvas.width !== physicalSize || canvas.height !== physicalSize) {
    canvas.width  = physicalSize;
    canvas.height = physicalSize;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  return size;
}

/**
 * グリッドのレイアウト情報を計算する
 */
function calcGrid(size, grid) {
  const PAD   = size * 0.12;
  const inner = size - PAD * 2;
  const stepX = inner / (grid.cols - 1);
  const stepY = inner / (grid.rows - 1);
  return { pad: PAD, stepX, stepY, size };
}

function dotPos(g, col, row) {
  return {
    x: g.pad + col * g.stepX,
    y: g.pad + row * g.stepY
  };
}

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

function drawLine(ctx, g, line, color, width, dashed, offsetX = 0, offsetY = 0) {
  const p1 = dotPos(g, line.x1, line.y1);
  const p2 = dotPos(g, line.x2, line.y2);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.setLineDash(dashed ? [8, 6] : []);
  ctx.beginPath();
  ctx.moveTo(p1.x + offsetX, p1.y + offsetY);
  ctx.lineTo(p2.x + offsetX, p2.y + offsetY);
  ctx.stroke();
  ctx.restore();
}

function drawEndpoints(ctx, g, lines, color, offsetX = 0, offsetY = 0) {
  for (const line of lines) {
    for (const pt of [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x + offsetX, p.y + offsetY, DOT_RADIUS + 1, 0, Math.PI * 2);
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

  // ヘッダーセルの高さ同期
  if (problem.level <= 2) {
    syncRowHeaderHeight('model', problem.grid.rows);
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

  // ★ ヒント線: 見本と同色（HINT_COLOR = MODEL_COLOR = '#1A73E8'）
  for (const line of (problem.hintLines || [])) {
    drawLine(ctx, g, line, HINT_COLOR, LINE_WIDTH + 1, false);
  }
  drawEndpoints(ctx, g, problem.hintLines || [], HINT_COLOR);

  // ユーザーが引いた線
  for (const line of CanvasState.userLines) {
    drawLine(ctx, g, line, USER_COLOR, LINE_WIDTH, false);
  }
  drawEndpoints(ctx, g, CanvasState.userLines, USER_COLOR);

  // ヘッダーセルの高さ同期
  if (problem.level <= 2) {
    syncRowHeaderHeight('answer', problem.grid.rows);
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

  const g      = calcGrid(size, problem.grid);
  const startP = dotPos(g, CanvasState.startPt.col, CanvasState.startPt.row);

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

  const oldOv = document.getElementById('canvas-overlay');
  const newOv = oldOv.cloneNode(true);
  oldOv.parentNode.replaceChild(newOv, oldOv);
  const ov = document.getElementById('canvas-overlay');

  const getPos = (e) => {
    const rect  = ov.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  };

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

    const rect   = ov.getBoundingClientRect();
    const rawPos = e.changedTouches
      ? { x: e.changedTouches[0].clientX - rect.left,
          y: e.changedTouches[0].clientY - rect.top }
      : CanvasState.currentPt;

    const overlayCtx = ov.getContext('2d');
    overlayCtx.clearRect(0, 0, ov.width, ov.height);

    if (!rawPos) return;
    const size    = rect.width || ov.offsetWidth || 300;
    const g       = calcGrid(size, problem.grid);
    const endSnap = snapToGrid(g, rawPos.x, rawPos.y);
    if (!endSnap) return;

    const s = CanvasState.startPt;
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
   ★ 正解線を緑で描画
   ★ ユーザーの誤答線をオフセットして重なりを避ける
   ============================================================ */
function drawWrongFeedback(problem, userLines) {
  const canvas = document.getElementById('canvas-wrong');
  const dpr    = window.devicePixelRatio || 1;

  const parentW = canvas.parentElement
    ? (canvas.parentElement.getBoundingClientRect().width
       || canvas.parentElement.offsetWidth
       || 280)
    : 280;
  const W = Math.min(Math.round(parentW * 0.85), 280);

  canvas.width        = Math.round(W * dpr);
  canvas.height       = Math.round(W * dpr);
  canvas.style.width  = W + 'px';
  canvas.style.height = W + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const g = calcGrid(W, problem.grid);

  drawBackground(ctx, W);
  drawDots(ctx, g, problem.grid);

  // ★ ユーザーの誤答線: オフセット(+4px, +4px)をかけて正解線とずらす
  //    薄いサーモンピンクで描画
  const OFFSET_X = 4;
  const OFFSET_Y = 4;
  for (const line of userLines) {
    drawLine(ctx, g, line, '#FF9999', LINE_WIDTH, false, OFFSET_X, OFFSET_Y);
  }
  // 誤答線の端点もオフセット
  for (const line of userLines) {
    for (const pt of [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x + OFFSET_X, p.y + OFFSET_Y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#FF9999';
      ctx.fill();
    }
  }

  // ★ 正解の線: 緑・太
  for (const line of problem.lines) {
    drawLine(ctx, g, line, CORRECT_LINE_COLOR, LINE_WIDTH + 2, false);
  }
  drawEndpoints(ctx, g, problem.lines, CORRECT_LINE_COLOR);
}

/* ============================================================
   リサイズ対応 — ResizeObserver
   ============================================================ */
function setupResizeObserver() {
  const redraw = () => {
    if (!CanvasState.problem) return;
    drawModel(CanvasState.problem);
    drawAnswer(CanvasState.problem);
    if (CanvasState.problem.level <= 2) {
      syncRowHeaderHeight('model',  CanvasState.problem.grid.rows);
      syncRowHeaderHeight('answer', CanvasState.problem.grid.rows);
    }
  };

  if (window.ResizeObserver) {
    const targets = [
      document.getElementById('canvas-model')?.parentElement,
      document.getElementById('canvas-answer')?.parentElement
    ].filter(Boolean);

    const ro = new ResizeObserver(redraw);
    targets.forEach(el => ro.observe(el));
  } else {
    window.addEventListener('resize', redraw);
  }
}

/* ============================================================
   初期化（問題切り替え時）
   ============================================================ */
function initCanvases(problem) {
  CanvasState.userLines  = [];
  CanvasState.dragging   = false;
  CanvasState.startPt    = null;
  CanvasState.currentPt  = null;
  CanvasState.problem    = problem;
}

document.addEventListener('DOMContentLoaded', setupResizeObserver);
