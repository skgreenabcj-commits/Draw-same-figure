/**
 * app.js  v2.5.5
 * 変更点 (v2.5.4 → v2.5.5):
 *   - loadQuestion: drawModel + clearAnswerLines の個別呼び出しを
 *                   initCanvases(prob) 1回に統一
 *                   → canvas.js v2.2 の initCanvases がリサイズ・描画・
 *                      インタラクション設定を全て行うため連動が保証される
 */

/* ============================================================
   §0. AppState
   ============================================================ */
const AppState = {
  level      : 0,
  problems   : [],
  currentIdx : 0,
  score      : 0,
  useAI      : false,
  apiKey     : ''
};

const PRAISE_LIST = ['Great!', 'Perfect!', 'Excellent!', 'Amazing!', 'Brilliant!'];

/* ============================================================
   §1. アラートタイプ → バナーメッセージ
   ============================================================ */
const ALERT_MESSAGES = {
  MODEL  : 'CHANGE AI model',
  PROMPT : 'CHECK AI prompt or CHANGE AI model',
  LEVEL  : 'CONSIDER changing the level limits',
  INFO   : 'Configure AI models for best experience'
};

/* ============================================================
   §2. 画面切替
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/* ============================================================
   §3. バナー
   ============================================================ */
function showErrorBanner(alertType, customMsg) {
  const banner = document.getElementById('model-error-banner');
  if (!banner) return;
  const msg      = customMsg || ALERT_MESSAGES[alertType] || String(alertType || 'AI error');
  const textEl   = banner.querySelector('.banner-text');
  const closeBtn = banner.querySelector('.banner-close');
  if (textEl)   textEl.textContent = `⚠️ ${msg} → tap to configure`;
  if (closeBtn) closeBtn.setAttribute('aria-label', 'Close alert');
  banner.dataset.alertType = alertType || '';
  banner.style.display     = 'flex';
}

function hideErrorBanner() {
  const banner = document.getElementById('model-error-banner');
  if (banner) {
    banner.style.display     = 'none';
    banner.dataset.alertType = '';
  }
}

/* ============================================================
   §4. 判定・進行ユーティリティ
   ============================================================ */
function judgeAnswer(answerLines, problem) {
  if (!problem || !Array.isArray(problem.lines)) return false;
  if (answerLines.length !== problem.lines.length) return false;
  const normalize = l =>
    `${Math.min(l.x1,l.x2)},${Math.min(l.y1,l.y2)},${Math.max(l.x1,l.x2)},${Math.max(l.y1,l.y2)}`;
  const aSet = new Set(answerLines.map(normalize));
  return problem.lines.every(l => aSet.has(normalize(l)));
}

function updateProgress() {
  const el = document.getElementById('progress-text');
  if (el) el.textContent = `${AppState.currentIdx + 1} / ${AppState.problems.length}`;
}

function updateHintMsg() {
  const cfg = (window.LEVEL_CFG || [])[AppState.level];
  const el  = document.getElementById('hint-msg');
  if (!el || !cfg) return;
  el.textContent = `lines: ${cfg.lines}  |  hints: ${cfg.hints}`;
}

function _refreshOverlayLimit() {
  const el = document.getElementById('overlay-limit');
  if (el) el.textContent = AppState.problems.length;
}

/* ============================================================
   §5. 問題読み込み
   ============================================================ */
/**
 * v2.5.5 修正:
 *   initCanvases(prob) を呼ぶだけで
 *   リサイズ・モデル描画・解答クリア・インタラクション設定が全て完了する
 */
function loadQuestion() {
  const prob = AppState.problems[AppState.currentIdx];
  if (!prob) return;

  // canvas.js v2.2 の initCanvases が全処理を担う
  if (window.initCanvases) {
    window.initCanvases(prob);
  } else {
    // フォールバック（canvas.js 読み込み失敗時）
    if (window.drawModel)        window.drawModel(prob);
    if (window.clearAnswerLines) window.clearAnswerLines();
  }

  updateProgress();
  updateHintMsg();
}

/* ============================================================
   §6. 答え合わせ / 次へ / 結果
   ============================================================ */
function checkAnswer() {
  const lines = window.getAnswerLines ? window.getAnswerLines() : [];
  const prob  = AppState.problems[AppState.currentIdx];
  if (judgeAnswer(lines, prob)) {
    AppState.score++;
    const scoreEl = document.getElementById('score-val');
    if (scoreEl) scoreEl.textContent = AppState.score;
    const el = document.getElementById('feedback-correct');
    if (el) {
      el.style.display = 'flex';
      setTimeout(() => { el.style.display = 'none'; goNext(); }, 900);
    }
  } else {
    if (window.drawWrongFeedback) window.drawWrongFeedback();
    const el = document.getElementById('feedback-wrong');
    if (el) {
      el.style.display = 'flex';
      setTimeout(() => el.style.display = 'none', 700);
    }
  }
}

function goNext() {
  AppState.currentIdx++;
  if (AppState.currentIdx >= AppState.problems.length) {
    showResult();
  } else {
    loadQuestion();
  }
}

function showResult() {
  const el = document.getElementById('result-score');
  if (el) el.textContent = `${AppState.score} / ${AppState.problems.length}`;
  showScreen('screen-result');
}

/* ============================================================
   §7. ローディング
   ============================================================ */
function showLoading(visible) {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = visible ? 'flex' : 'none';
}

/* ============================================================
   §8. ゲーム開始
   ============================================================ */
async function startGame() {
  AppState.score      = 0;
  AppState.currentIdx = 0;

  const apiKey    = GeminiAPI.loadApiKey();
  AppState.useAI  = !!apiKey;
  AppState.apiKey = apiKey;

  if (!AppState.useAI) {
    const local = (window.LOCAL_PROBLEMS || [])[AppState.level] || [];
    if (local.length === 0) {
      showErrorBanner('MODEL', 'No problems available. Please check problems.js.');
      return;
    }
    AppState.problems = local;
    showScreen('screen-game');
    loadQuestion();
    _refreshOverlayLimit();
    return;
  }

  showLoading(true);

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout: AI generation took too long')), 30000)
    );
    const result = await Promise.race([
      GeminiAPI.generateProblems(AppState.level),
      timeoutPromise
    ]);
    AppState.problems = result.problems;
    if (result.alertType) {
      showErrorBanner(result.alertType);
    } else {
      hideErrorBanner();
    }
  } catch (err) {
    const fallback    = (window.LOCAL_PROBLEMS || [])[AppState.level];
    const hasFallback = Array.isArray(fallback) && fallback.length > 0;
    showLoading(false);
    if (!hasFallback) {
      showErrorBanner('MODEL', `AI error & no local problems. (${err.message})`);
      return;
    }
    AppState.problems = fallback;
    showErrorBanner('MODEL', err.message);
  } finally {
    showLoading(false);
  }

  showScreen('screen-game');
  loadQuestion();
  _refreshOverlayLimit();
}

/* ============================================================
   §9. イベントバインド
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  try {
    document.getElementById('btn-start')
      ?.addEventListener('click', startGame);
  } catch (e) { console.error('[app] btn-start bind error:', e); }

  try {
    document.getElementById('btn-toggle-api')
      ?.addEventListener('click', () => {
        const panel = document.getElementById('api-key-panel');
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
  } catch (e) { console.error('[app] btn-toggle-api bind error:', e); }

  try {
    document.getElementById('btn-save-api')
      ?.addEventListener('click', () => {
        const val = document.getElementById('input-api-key')?.value?.trim();
        if (!val) return;
        GeminiAPI.saveApiKey(val);
        const panel = document.getElementById('api-key-panel');
        if (panel) panel.style.display = 'none';
      });
  } catch (e) { console.error('[app] btn-save-api bind error:', e); }

  try {
    document.querySelectorAll('[data-level]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-level]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        AppState.level = parseInt(btn.dataset.level, 10);
      });
    });
    const defaultBtn = document.querySelector('[data-level="0"]');
    if (defaultBtn) defaultBtn.click();
  } catch (e) { console.error('[app] level selector bind error:', e); }

  try {
    document.getElementById('btn-admin-model')
      ?.addEventListener('click', () => window.open('admin.html', '_blank'));
  } catch (e) { console.error('[app] btn-admin-model bind error:', e); }

  try {
    document.getElementById('btn-home')
      ?.addEventListener('click', () => showScreen('screen-start'));
  } catch (e) { console.error('[app] btn-home bind error:', e); }

  try {
    document.getElementById('btn-clear')
      ?.addEventListener('click', () => {
        if (window.clearAnswerLines) window.clearAnswerLines();
      });
  } catch (e) { console.error('[app] btn-clear bind error:', e); }

  try {
    document.getElementById('btn-undo')
      ?.addEventListener('click', () => {
        if (window.undoLastLine) window.undoLastLine();
      });
  } catch (e) { console.error('[app] btn-undo bind error:', e); }

  try {
    document.getElementById('btn-check')
      ?.addEventListener('click', checkAnswer);
  } catch (e) { console.error('[app] btn-check bind error:', e); }

  try {
    document.getElementById('btn-next')
      ?.addEventListener('click', goNext);
  } catch (e) { console.error('[app] btn-next bind error:', e); }

  try {
    document.getElementById('btn-retry')
      ?.addEventListener('click', startGame);
  } catch (e) { console.error('[app] btn-retry bind error:', e); }

  try {
    document.getElementById('btn-result-home')
      ?.addEventListener('click', () => showScreen('screen-start'));
  } catch (e) { console.error('[app] btn-result-home bind error:', e); }

  try {
    document.querySelector('#model-error-banner .banner-close')
      ?.addEventListener('click', (e) => { e.stopPropagation(); hideErrorBanner(); });
    document.querySelector('#model-error-banner .banner-text')
      ?.addEventListener('click', () => window.open('admin.html', '_blank'));
  } catch (e) { console.error('[app] banner bind error:', e); }

  try {
    window.addEventListener('geminiStatusUpdate', (e) => {
      const status = e.detail || {};
      if (status.alertType) {
        showErrorBanner(status.alertType);
      } else {
        hideErrorBanner();
      }
    });
  } catch (e) { console.error('[app] geminiStatusUpdate bind error:', e); }

  try {
    const hasKey   = !!GeminiAPI.loadApiKey();
    const hasChain = !!GeminiAPI.loadAdminChain();
    if (hasKey && !hasChain) showErrorBanner('INFO');
  } catch (e) { console.error('[app] initial banner error:', e); }

});
