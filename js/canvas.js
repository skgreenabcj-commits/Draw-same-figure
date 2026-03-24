/**
 * canvas.js  v2.2
 * 変更点 (v2.1 → v2.2):
 *   - initCanvases: resizeAll() + drawModel() + setupInteraction() を内部で実行し
 *                   app.js から呼ぶだけでキャンバスが表示・連動するよう修正
 *   - resizeAll: canvas-answer-wrap の実サイズを基準にDPR対応リサイズ
 *   - ResizeObserver を answer-wrap に設定し、ウィンドウリサイズでも再描画
 */

'use strict';

/* ============================================================
   §0. 共有ステート
   ============================================================ */
const CanvasState = {
  problem    : null,
  userLines  : [],
  dragging   : false,
  startPt    : null,
  currentPt  : null
};

/* ============================================================
   §1. 描画定数
   ============================================================ */
const GRID_N      = 3;       // グリッド分割数（0〜3 = 4点）
const DOT_R       = 6;       // ドット半径(px) ※論理ピクセル
const LINE_W      = 3;       // 線幅
const SNAP_DIST   = 28;      // スナップ距離(px)
const PAD_RATIO   = 0.13;    // キャンバスに対するパディング比率

const COLOR_BG        = '#FFFFFF';
const COLOR_DOT       = '#CCCCDD';
const COLOR_DOT_SNAP  = '#FF6B6B';
const COLOR_MODEL     = '#2D2D2D';
const COLOR_USER      = '#4A90D9';
const COLOR_PREVIEW   = 'rgba(74,144,217,0.45)';
const COLOR_WRONG     = 'rgba(255,80,80,0.18)';
const COLOR_HINT      = '#FF8E53';

/* ============================================================
   §2. キャンバス要素取得
   ============================================================ */
function _getCanvas(id) {
  const el = document.getElementById(id);
  if (!el) console.error(`[canvas] element not found: #${id}`);
  return el;
}

function _ctx(id) {
  const el = _getCanvas(id);
  return el ? el.getContext('2d') : null;
}

/* ============================================================
   §3. DPR対応リサイズ
   ============================================================ */
/**
 * キャンバス要素を論理サイズ(CSS px)に合わせて
 * DPR(devicePixelRatio)分の解像度でリサイズする
 */
function _resizeCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width  = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { cssW, cssH, dpr };
}

/**
 * モデル・解答・オーバーレイの3枚を同時リサイズ
 * 基準サイズは .canvas-answer-wrap の実際の幅
 */
function resizeAll() {
  const wrap = document.querySelector('.canvas-answer-wrap');
  const modelEl   = _getCanvas('canvas-model');
  const answerEl  = _getCanvas('canvas-answer');
  const overlayEl = _getCanvas('canvas-overlay');

  if (!wrap || !modelEl || !answerEl || !overlayEl) return;

  const size = wrap.clientWidth || 280; // 正方形

  _resizeCanvas(modelEl,   size, size);
  _resizeCanvas(answerEl,  size, size);
  _resizeCanvas(overlayEl, size, size);
}

/* ============================================================
   §4. グリッド座標計算
   ============================================================ */
/**
 * グリッド点(gx, gy)→キャンバス論理座標(px, py) に変換
 */
function _gridToPx(gx, gy, cssSize) {
  const pad  = cssSize * PAD_RATIO;
  const step = (cssSize - pad * 2) / GRID_N;
  return {
    x: pad + gx * step,
    y: pad + gy * step
  };
}

/**
 * キャンバス論理座標(x,y)→最近グリッド点(gx,gy)
 * SNAP_DIST 以内でなければ null
 */
function _pxToGrid(x, y, cssSize) {
  const pad  = cssSize * PAD_RATIO;
  const step = (cssSize - pad * 2) / GRID_N;
  let best = null, bestD = SNAP_DIST;
  for (let gy = 0; gy <= GRID_N; gy++) {
    for (let gx = 0; gx <= GRID_N; gx++) {
      const px = pad + gx * step;
      const py = pad + gy * step;
      const d  = Math.hypot(x - px, y - py);
      if (d < bestD) { bestD = d; best = { gx, gy }; }
    }
  }
  return best;
}

/* ============================================================
   §5. 描画ヘルパー
   ============================================================ */
function _drawBackground(ctx, size) {
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, size, size);
}

function _drawDots(ctx, size, snapPt) {
  const pad  = size * PAD_RATIO;
  const step = (size - pad * 2) / GRID_N;
  for (let gy = 0; gy <= GRID_N; gy++) {
    for (let gx = 0; gx <= GRID_N; gx++) {
      const px = pad + gx * step;
      const py = pad + gy * step;
      const isSnap = snapPt && snapPt.gx === gx && snapPt.gy === gy;
      ctx.beginPath();
      ctx.arc(px, py, isSnap ? DOT_R * 1.4 : DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = isSnap ? COLOR_DOT_SNAP : COLOR_DOT;
      ctx.fill();
    }
  }
}

function _drawLines(ctx, lines, size, color, width) {
  if (!lines || lines.length === 0) return;
  const pad  = size * PAD_RATIO;
  const step = (size - pad * 2) / GRID_N;
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  lines.forEach(l => {
    const x1 = pad + l.x1 * step, y1 = pad + l.y1 * step;
    const x2 = pad + l.x2 * step, y2 = pad + l.y2 * step;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });
}

function _drawHintLines(ctx, lines, size) {
  if (!lines || lines.length === 0) return;
  _drawLines(ctx, lines, size, COLOR_HINT, LINE_W * 1.5);
}

function _drawPreviewLine(ctx, startPt, currentPt, size) {
  if (!startPt || !currentPt) return;
  const pad  = size * PAD_RATIO;
  const step = (size - pad * 2) / GRID_N;
  const x1 = pad + startPt.gx * step, y1 = pad + startPt.gy * step;
  ctx.strokeStyle = COLOR_PREVIEW;
  ctx.lineWidth   = LINE_W;
  ctx.lineCap     = 'round';
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(currentPt.x, currentPt.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

/* ============================================================
   §6. 公開: モデル描画
   ============================================================ */
function drawModel(problem) {
  const canvas = _getCanvas('canvas-model');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const size = canvas.clientWidth || canvas.width;

  _drawBackground(ctx, size);
  _drawDots(ctx, size, null);
  if (problem && Array.isArray(problem.lines)) {
    _drawLines(ctx, problem.lines, size, COLOR_MODEL, LINE_W);
  }
  if (problem && Array.isArray(problem.hintLines)) {
    _drawHintLines(ctx, problem.hintLines, size);
  }
}

/* ============================================================
   §7. 公開: 解答キャンバス描画
   ============================================================ */
function drawAnswer() {
  const canvas = _getCanvas('canvas-answer');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const size = canvas.clientWidth || canvas.width;

  _drawBackground(ctx, size);
  _drawDots(ctx, size, CanvasState.dragging ? CanvasState.currentGridPt : null);
  _drawLines(ctx, CanvasState.userLines, size, COLOR_USER, LINE_W);
}

function _drawOverlay() {
  const canvas = _getCanvas('canvas-overlay');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const size = canvas.clientWidth || canvas.width;

  ctx.clearRect(0, 0, size, size);
  if (CanvasState.dragging) {
    _drawPreviewLine(ctx, CanvasState.startPt, CanvasState.currentPt, size);
  }
}

/* ============================================================
   §8. 公開: 不正解フィードバック
   ============================================================ */
function drawWrongFeedback() {
  const canvas = _getCanvas('canvas-answer');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const size = canvas.clientWidth || canvas.width;
  ctx.fillStyle = COLOR_WRONG;
  ctx.fillRect(0, 0, size, size);
  setTimeout(drawAnswer, 600);
}

/* ============================================================
   §9. タッチ / マウス座標取得
   ============================================================ */
function _getEventPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const touch = e.touches ? e.touches[0] : e;
  return {
    x: touch.clientX - rect.left,
    y: touch.clientY - rect.top
  };
}

/* ============================================================
   §10. インタラクション設定
   ============================================================ */
function setupInteraction() {
  const canvas = _getCanvas('canvas-overlay');
  if (!canvas) return;

  // 既存リスナーをクリアするため clone で差し替え
  const fresh = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(fresh, canvas);
  fresh.style.pointerEvents = 'auto'; // タッチ受付

  function onStart(e) {
    e.preventDefault();
    const answerCanvas = _getCanvas('canvas-answer');
    if (!answerCanvas) return;
    const size = answerCanvas.clientWidth || answerCanvas.width;
    const pos  = _getEventPos(e, fresh);
    const grid = _pxToGrid(pos.x, pos.y, size);
    if (!grid) return;
    CanvasState.dragging       = true;
    CanvasState.startPt        = grid;
    CanvasState.currentPt      = pos;
    CanvasState.currentGridPt  = grid;
    drawAnswer();
    _drawOverlay();
  }

  function onMove(e) {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    const answerCanvas = _getCanvas('canvas-answer');
    if (!answerCanvas) return;
    const size = answerCanvas.clientWidth || answerCanvas.width;
    const pos  = _getEventPos(e, fresh);
    const grid = _pxToGrid(pos.x, pos.y, size);
    CanvasState.currentPt     = pos;
    CanvasState.currentGridPt = grid || CanvasState.currentGridPt;
    drawAnswer();
    _drawOverlay();
  }

  function onEnd(e) {
    e.preventDefault();
    if (!CanvasState.dragging) return;
    const answerCanvas = _getCanvas('canvas-answer');
    if (!answerCanvas) return;
    const size  = answerCanvas.clientWidth || answerCanvas.width;
    const pos   = _getEventPos(e.changedTouches ? { touches: e.changedTouches } : e, fresh);
    const grid  = _pxToGrid(pos.x, pos.y, size);
    CanvasState.dragging = false;

    if (grid && CanvasState.startPt) {
      const s = CanvasState.startPt;
      const g = grid;
      // 同一点でなければ追加
      if (!(s.gx === g.gx && s.gy === g.gy)) {
        CanvasState.userLines.push({ x1: s.gx, y1: s.gy, x2: g.gx, y2: g.gy });
      }
    }
    CanvasState.startPt   = null;
    CanvasState.currentPt = null;
    drawAnswer();
    _drawOverlay();
  }

  // マウス
  fresh.addEventListener('mousedown',  onStart, { passive: false });
  fresh.addEventListener('mousemove',  onMove,  { passive: false });
  fresh.addEventListener('mouseup',    onEnd,   { passive: false });
  fresh.addEventListener('mouseleave', onEnd,   { passive: false });

  // タッチ
  fresh.addEventListener('touchstart', onStart, { passive: false });
  fresh.addEventListener('touchmove',  onMove,  { passive: false });
  fresh.addEventListener('touchend',   onEnd,   { passive: false });
}

/* ============================================================
   §11. 公開: 解答取得 / 操作
   ============================================================ */
function getAnswerLines()  { return CanvasState.userLines.slice(); }
function clearAnswerLines() { CanvasState.userLines = []; drawAnswer(); }
function undoLastLine()     { CanvasState.userLines.pop(); drawAnswer(); }

/* ============================================================
   §12. ResizeObserver（ウィンドウリサイズ対応）
   ============================================================ */
let _resizeTimer = null;
function _onResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    resizeAll();
    drawModel(CanvasState.problem);
    drawAnswer();
  }, 80);
}

/* ============================================================
   §13. 公開: キャンバス初期化（問題切り替え時）
   ============================================================ */
/**
 * v2.2 修正:
 *   ステートリセットに加えて resizeAll()・drawModel()・drawAnswer()・
 *   setupInteraction() を内部実行するため、app.js からは
 *   initCanvases(problem) を呼ぶだけでキャンバスが完全に連動する
 */
function initCanvases(problem) {
  // ステートリセット
  CanvasState.userLines  = [];
  CanvasState.dragging   = false;
  CanvasState.startPt    = null;
  CanvasState.currentPt  = null;
  CanvasState.problem    = problem;

  // リサイズ → 描画 → インタラクション設定
  resizeAll();
  drawModel(problem);
  drawAnswer();
  setupInteraction();
}

/* ============================================================
   §14. DOMContentLoaded 初期化
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // ResizeObserver で canvas-answer-wrap を監視
  const wrap = document.querySelector('.canvas-answer-wrap');
  if (wrap && window.ResizeObserver) {
    const ro = new ResizeObserver(_onResize);
    ro.observe(wrap);
  } else {
    window.addEventListener('resize', _onResize);
  }

  // グローバル公開（app.js から参照）
  window.drawModel       = drawModel;
  window.drawAnswer      = drawAnswer;
  window.initCanvases    = initCanvases;
  window.setupInteraction= setupInteraction;
  window.getAnswerLines  = getAnswerLines;
  window.clearAnswerLines= clearAnswerLines;
  window.undoLastLine    = undoLastLine;
  window.drawWrongFeedback = drawWrongFeedback;
  window.resizeAll       = resizeAll;
});
