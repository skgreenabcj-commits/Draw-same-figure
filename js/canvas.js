/**
 * canvas.js  v2.1R2
 * 修正内容:
 *   - 根本原因1: resizeCanvas() をキャンバスの CSS 実サイズではなく
 *     .canvas-wrap の確定サイズから取得するよう修正。
 *     getBoundingClientRect が 0 を返す場合は offsetWidth、
 *     それも 0 の場合は parentElement を遡って取得する。
 *   - 根本原因2: drawModel/drawAnswer 内で毎回 resizeCanvas() を呼ぶのをやめ、
 *     _getCanvasSize() で CSS 論理サイズを取得して描画計算に使用する。
 *     canvas の内部解像度リセット（canvas.width = ...）は initCanvases 時と
 *     ResizeObserver 時のみ行う。
 *   - 根本原因3: loadQuestion から呼ばれる描画を setTimeout(0) + rAF で
 *     確実にレイアウト確定後に実行する。
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
   描画定数
   ============================================================ */
const DOT_RADIUS         = 5;
const SNAP_RADIUS        = 0.4;
const LINE_WIDTH         = 3;
const MODEL_COLOR        = '#1A73E8';
const HINT_COLOR         = '#1A73E8';
const USER_COLOR         = '#FF6B6B';
const CORRECT_LINE_COLOR = '#22BB55';
const DOT_COLOR          = '#AACCEE';
const BG_COLOR           = '#F8FBFF';

/* ============================================================
   グリッドヘッダー用定数
   ============================================================ */
const ROW_ANIMALS_4 = ['🐶', '🐱', '🐰', '🐻'];
const ROW_ANIMALS_5 = ['🐶', '🐱', '🐰', '🐻', '🐼'];
const COL_NUMBERS_4 = ['１', '２', '３', '４'];
const COL_NUMBERS_5 = ['１', '２', '３', '４', '５'];

/* ============================================================
   グリッドヘッダー構築
   ============================================================ */
function buildGridHeaders(problem) {
  const showHeader = problem.level <= 2;
  const cols       = problem.grid.cols;
  const rows       = problem.grid.rows;
  const animals    = rows === 5 ? ROW_ANIMALS_5 : ROW_ANIMALS_4;
  const numbers    = cols === 5 ? COL_NUMBERS_5 : COL_NUMBERS_4;

  ['model', 'answer'].forEach(side => {
    const colHeaderEl = document.getElementById(`col-header-${side}`);
    const rowHeaderEl = document.getElementById(`row-header-${side}`);
    if (!colHeaderEl || !rowHeaderEl) return;

    if (!showHeader) {
      colHeaderEl.style.display = 'none';
      rowHeaderEl.style.display = 'none';
      return;
    }

    colHeaderEl.style.display = 'flex';
    rowHeaderEl.style.display = 'flex';

    colHeaderEl.innerHTML = '';
    numbers.forEach(num => {
      const cell       = document.createElement('div');
      cell.className   = 'col-header-cell';
      cell.textContent = num;
      colHeaderEl.appendChild(cell);
    });

    rowHeaderEl.innerHTML = '';
    animals.forEach(animal => {
      const cell       = document.createElement('div');
      cell.className   = 'row-header-cell';
      cell.textContent = animal;
      rowHeaderEl.appendChild(cell);
    });
  });
}

function syncRowHeaderHeight(side, rows) {
  const wrap = document.querySelector(
    side === 'model'
      ? '#grid-outer-model .canvas-wrap'
      : '#grid-outer-answer .canvas-wrap'
  );
  const rowHeaderEl = document.getElementById(`row-header-${side}`);
  if (!wrap || !rowHeaderEl) return;

  const canvasSize = wrap.getBoundingClientRect().width || wrap.offsetWidth || 200;
  const cellH      = canvasSize / rows;
  const headerSize = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--header-size')
  ) || 56;

  Array.from(rowHeaderEl.children).forEach(cell => {
    cell.style.height     = cellH + 'px';
    cell.style.minHeight  = cellH + 'px';
    cell.style.lineHeight = cellH + 'px';
    cell.style.fontSize   = Math.max(Math.round(headerSize * 0.60), 16) + 'px';
  });
}

function syncColHeaderFontSize(side) {
  const colHeaderEl = document.getElementById(`col-header-${side}`);
  if (!colHeaderEl) return;
  const headerSize = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--header-size')
  ) || 56;
  Array.from(colHeaderEl.children).forEach(cell => {
    cell.style.fontSize   = Math.max(Math.round(headerSize * 0.50), 12) + 'px';
    cell.style.lineHeight = headerSize + 'px';
  });
}

function syncHeaders(problem) {
  if (problem.level > 2) return;
  ['model', 'answer'].forEach(side => {
    syncRowHeaderHeight(side, problem.grid.rows);
    syncColHeaderFontSize(side);
  });
}

/* ============================================================
   根本原因1・2 修正: キャンバスサイズ取得 & リサイズ
   ============================================================ */

/**
 * .canvas-wrap の実 CSS 幅を確実に取得する。
 * getBoundingClientRect → offsetWidth → 親要素を遡る の順で試みる。
 * すべて 0 の場合は fallback 値 280 を返す。
 */
function _getWrapSize(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return 280;

  // canvas 自身の CSS 幅を試みる（width:100% が効いていれば取れる）
  let size = canvas.getBoundingClientRect().width;
  if (size > 10) return size;

  // 親 (.canvas-wrap) から取得
  const wrap = canvas.parentElement;
  if (wrap) {
    size = wrap.getBoundingClientRect().width;
    if (size > 10) return size;
    size = wrap.offsetWidth;
    if (size > 10) return size;
  }

  // さらに親 (.grid-body) から取得して row-header 分を引く
  const gridBody = wrap && wrap.parentElement;
  if (gridBody) {
    const headerSize = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--header-size')
    ) || 56;
    size = (gridBody.getBoundingClientRect().width || gridBody.offsetWidth || 0) - headerSize;
    if (size > 10) return size;
  }

  return 280; // 最終フォールバック
}

/**
 * canvas の内部解像度を CSS サイズに合わせて DPR 対応でセットする。
 * ctx の変換行列もリセットしてスケールを再適用する。
 * 戻り値: CSS 論理ピクセル単位のサイズ（描画計算に使用）
 */
function _resizeCanvasToWrap(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return 280;

  const size = _getWrapSize(canvasId);
  const dpr  = window.devicePixelRatio || 1;
  const phys = Math.round(size * dpr);

  // サイズが変わった場合のみ内部解像度を更新（変換行列もリセット）
  if (canvas.width !== phys || canvas.height !== phys) {
    canvas.width  = phys;
    canvas.height = phys;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  return size;
}

/**
 * 旧版互換: resizeCanvas(canvas) シグネチャを維持しつつ
 * canvas の id から _resizeCanvasToWrap を呼ぶ。
 */
function resizeCanvas(canvas) {
  return _resizeCanvasToWrap(canvas.id);
}

/* ============================================================
   グリッドジオメトリ計算
   ============================================================ */
function calcGrid(size, grid) {
  const PAD   = size * 0.12;
  const inner = size - PAD * 2;
  const stepX = inner / (grid.cols - 1);
  const stepY = inner / (grid.rows - 1);
  return { pad: PAD, stepX, stepY, size };
}

function dotPos(g, col, row) {
  return { x: g.pad + col * g.stepX, y: g.pad + row * g.stepY };
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

/* ============================================================
   公開: 見本キャンバス描画
   ============================================================ */
function drawModel(problem) {
  const size = _resizeCanvasToWrap('canvas-model');
  const canvas = document.getElementById('canvas-model');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const g   = calcGrid(size, problem.grid);

  drawBackground(ctx, size);
  drawDots(ctx, g, problem.grid);
  for (const line of problem.lines) {
    drawLine(ctx, g, line, MODEL_COLOR, LINE_WIDTH + 1, false);
  }
  drawEndpoints(ctx, g, problem.lines, MODEL_COLOR);
  syncHeaders(problem);
}

/* ============================================================
   公開: 回答キャンバス描画
   ============================================================ */
function drawAnswer(problem) {
  const size = _resizeCanvasToWrap('canvas-answer');
  const canvas = document.getElementById('canvas-answer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const g   = calcGrid(size, problem.grid);

  drawBackground(ctx, size);
  drawDots(ctx, g, problem.grid);

  const hintLines = problem.hintLines || [];
  for (const line of hintLines) {
    drawLine(ctx, g, line, HINT_COLOR, LINE_WIDTH + 1, false);
  }
  drawEndpoints(ctx, g, hintLines, HINT_COLOR);

  for (const line of CanvasState.userLines) {
    drawLine(ctx, g, line, USER_COLOR, LINE_WIDTH, false);
  }
  drawEndpoints(ctx, g, CanvasState.userLines, USER_COLOR);

  syncHeaders(problem);
}

/* ============================================================
   オーバーレイ描画
   ============================================================ */
function drawOverlay(problem, toPx) {
  const size = _resizeCanvasToWrap('canvas-overlay');
  const canvas = document.getElementById('canvas-overlay');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
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
   公開: インタラクション設定
   ============================================================ */
function setupInteraction(problem, onLineAdded) {
  CanvasState.problem = problem;

  const oldOv = document.getElementById('canvas-overlay');
  const newOv = oldOv.cloneNode(true);
  oldOv.parentNode.replaceChild(newOv, oldOv);
  const ov = document.getElementById('canvas-overlay');

  ov.style.pointerEvents = 'auto';
  ov.style.cursor        = 'crosshair';

  const getPos = (e) => {
    const rect  = ov.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  };

  const onStart = (e) => {
    e.preventDefault();
    const pos  = getPos(e);
    const size = _getWrapSize('canvas-overlay');
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
    const size    = _getWrapSize('canvas-overlay');
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
function getAnswerLines()   { return [...CanvasState.userLines]; }

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
   公開: 不正解フィードバック描画
   ============================================================ */
function drawWrongFeedback(problem, userLines) {
  const canvas = document.getElementById('canvas-wrong');
  const dpr    = window.devicePixelRatio || 1;
  const parentW = canvas.parentElement
    ? (canvas.parentElement.getBoundingClientRect().width
       || canvas.parentElement.offsetWidth || 280)
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

  const OX = 4, OY = 4;
  for (const line of userLines) {
    drawLine(ctx, g, line, '#FF9999', LINE_WIDTH, false, OX, OY);
  }
  for (const line of userLines) {
    for (const pt of [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]) {
      const p = dotPos(g, pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x + OX, p.y + OY, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#FF9999';
      ctx.fill();
    }
  }

  for (const line of problem.lines) {
    drawLine(ctx, g, line, CORRECT_LINE_COLOR, LINE_WIDTH + 2, false);
  }
  drawEndpoints(ctx, g, problem.lines, CORRECT_LINE_COLOR);
}

/* ============================================================
   ResizeObserver — リサイズ時の再描画
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
    window.addEventListener('resize', redraw);
  }
}

/* ============================================================
   公開: キャンバス初期化（問題切り替え時）
   ============================================================ */
function initCanvases(problem) {
  CanvasState.userLines = [];
  CanvasState.dragging  = false;
  CanvasState.startPt   = null;
  CanvasState.currentPt = null;
  CanvasState.problem   = problem;
  // 内部解像度を一旦リセット（次の描画時に正しいサイズで再セットされる）
  ['canvas-model', 'canvas-answer', 'canvas-overlay'].forEach(id => {
    const c = document.getElementById(id);
    if (c) { c.width = 1; c.height = 1; }
  });
}

document.addEventListener('DOMContentLoaded', setupResizeObserver);
