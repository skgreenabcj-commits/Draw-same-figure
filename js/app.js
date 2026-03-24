/**
 * app.js  v2.5.3
 * 変更点 (v2.5.2 → v2.5.3):
 *   - DEBUG-2: startGame の catch ブロックに LOCAL_PROBLEMS 未定義ガードを追加
 *              フォールバック問題が0件の場合はゲーム画面に遷移せず早期 return
 *              → drawModel(undefined) によるクラッシュを防止
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

function updateHintMsg(problem) {
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
   §5. 問題読み込み / チェック / 次へ
   ============================================================ */
function loadQuestion() {
  const prob = AppState.problems[AppState.currentIdx];
  if (!prob) return;
  if (window.drawModel)        window.drawModel(prob);
  if (window.clearAnswerLines) window.clearAnswerLines();
  updateProgress();
  updateHintMsg(prob);
}

function checkAnswer() {
  const lines = window.getAnswerLines ? window.getAnswerLines() : [];
  const prob  = AppState.problems[AppState.currentIdx];
  if (judgeAnswer(lines, prob)) {
    AppState.score++;
    document.getElementById('score-val').textContent = AppState.score;
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
  document.getElementById('result-score').textContent =
    `${AppState.score} / ${AppState.problems.length}`;
  showScreen('screen-result');
}

/* ============================================================
   §6. ローディング
   ============================================================ */
function showLoading(visible) {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = visible ? 'flex' : 'none';
}

/* ============================================================
   §7. ゲーム開始（DEBUG-2 修正箇所）
   ============================================================ */
async function startGame() {
  AppState.score      = 0;
  AppState.currentIdx = 0;

  const apiKey    = GeminiAPI.loadApiKey();
  AppState.useAI  = !!apiKey;
  AppState.apiKey = apiKey;

  // API キーなし → ローカル問題で即開始
  if (!AppState.useAI) {
    const local = (window.LOCAL_PROBLEMS || [])[AppState.level] || [];
    if (local.length === 0) {
      // ローカル問題すら存在しない場合はスタート画面に留まる
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

    // alertType が null/falsy の場合は必ずバナーを閉じる
    if (result.alertType) {
      showErrorBanner(result.alertType);
    } else {
      hideErrorBanner();
    }

  } catch (err) {
    // ----------------------------------------------------------------
    // DEBUG-2 修正:
    //   タイムアウト / ネットワークエラー時のフォールバック処理を強化
    //
    //   旧実装:
    //     AppState.problems = (window.LOCAL_PROBLEMS || [])[AppState.level] || [];
    //     → LOCAL_PROBLEMS が未定義 or 該当レベルが空の場合に problems=[] のまま
    //       ゲーム画面へ遷移し、drawModel(undefined) でクラッシュ
    //
    //   新実装:
    //     フォールバックが0件の場合は showLoading を閉じてバナーを表示し、
    //     ゲーム画面へ遷移しない（早期 return）
    // ----------------------------------------------------------------
    const fallback = (window.LOCAL_PROBLEMS || [])[AppState.level];
    const hasFallback = Array.isArray(fallback) && fallback.length > 0;

    showLoading(false); // finally より先に閉じてから return するため個別に呼ぶ

    if (!hasFallback) {
      // フォールバック問題が存在しない → スタート画面に留まりバナー表示
      showErrorBanner('MODEL',
        `AI error & no local problems. (${err.message})`
      );
      return; // ← ゲーム画面に遷移しない（クラッシュ防止）
    }

    // フォールバック問題あり → ローカル問題でゲーム継続
    AppState.problems = fallback;
    showErrorBanner('MODEL', err.message);

  } finally {
    // DEBUG-2 修正: 早期 return したケースでは既に showLoading(false) 済みだが、
    // finally は必ず実行されるため冪等な操作（display:none）として問題なし
    showLoading(false);
  }

  // catch で早期 return した場合はここに到達しない
  showScreen('screen-game');
  loadQuestion();
  _refreshOverlayLimit();
}

/* ============================================================
   §8. イベントバインド
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  // レベル選択
  document.querySelectorAll('[data-level]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-level]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
    });
  });
  // デフォルトレベル
  const defaultBtn = document.querySelector('[data-level="0"]');
  if (defaultBtn) defaultBtn.click();

  // スタートボタン
  document.getElementById('btn-start')?.addEventListener('click', startGame);

  // API キーパネル
  document.getElementById('btn-toggle-api')?.addEventListener('click', () => {
    const panel = document.getElementById('api-key-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btn-save-api')?.addEventListener('click', () => {
    const val = document.getElementById('input-api-key')?.value?.trim();
    if (val) {
      GeminiAPI.saveApiKey(val);
      document.getElementById('api-key-panel').style.display = 'none';
    }
  });

  // 管理画面リンク
  document.getElementById('btn-admin-model')?.addEventListener('click', () => {
    window.open('admin.html', '_blank');
  });

  // ゲームコントロール
  document.getElementById('btn-home')?.addEventListener('click', () => showScreen('screen-start'));
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (window.clearAnswerLines) window.clearAnswerLines();
  });
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (window.undoLastLine) window.undoLastLine();
  });
  document.getElementById('btn-check')?.addEventListener('click', checkAnswer);
  document.getElementById('btn-next')?.addEventListener('click',  goNext);

  // リザルト画面
  document.getElementById('btn-retry')?.addEventListener('click', startGame);
  document.getElementById('btn-result-home')?.addEventListener('click', () => showScreen('screen-start'));

  // バナーの × ボタン（閉じるだけ）
  document.querySelector('#model-error-banner .banner-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideErrorBanner();
  });
  // バナー本文クリック → admin.html
  document.querySelector('#model-error-banner .banner-text')?.addEventListener('click', () => {
    window.open('admin.html', '_blank');
  });

  // geminiStatusUpdate リスナー
  window.addEventListener('geminiStatusUpdate', (e) => {
    const status = e.detail || {};
    if (status.alertType) {
      showErrorBanner(status.alertType);
    } else {
      hideErrorBanner();
    }
  });

  // 初回起動: API キーあり・チェーン未設定 → info バナー
  const hasKey   = !!GeminiAPI.loadApiKey();
  const hasChain = !!GeminiAPI.loadAdminChain();
  if (hasKey && !hasChain) {
    showErrorBanner('INFO');
  }
});
