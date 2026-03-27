// ============================================================
// app.js  v3.3  (BUG-F1 修正版)
//   BUG-A  : Lv2/Lv3 のキャンバスオーバーレイを常時表示
//   BUG-E  : 初期バナー判定を loadApiKey() で直接チェック
//   BUG-F1 : DOMContentLoaded 内の setTimeout バナーブロック
//            (block①) を削除し、即時ブロック(block②) に統一
// ============================================================

'use strict';

// ─────────────────────────────────────────
// 定数
// ─────────────────────────────────────────
const STORAGE_KEY_API  = 'gemini_api_key';
const MAX_QUESTIONS    = 5;
const PRAISE_LIST = [
  'すごい！', 'やったね！', 'かんぺき！', 'すばらしい！',
  'よくできました！', 'さすが！', 'すてき！', 'ナイス！',
];

// ─────────────────────────────────────────
// アプリ状態
// ─────────────────────────────────────────
const AppState = {
  level    : 1,
  problems : [],
  index    : 0,
  score    : 0,
  apiKey   : '',
};

// ─────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────
function randomPraise() {
  return PRAISE_LIST[Math.floor(Math.random() * PRAISE_LIST.length)];
}

function loadApiKey() {
  return localStorage.getItem(STORAGE_KEY_API) || '';
}

function saveApiKey(key) {
  localStorage.setItem(STORAGE_KEY_API, key);
  AppState.apiKey = key;
}

// ─────────────────────────────────────────
// 画面切り替え
// ─────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.remove('hidden');
}

// ─────────────────────────────────────────
// ローディングオーバーレイ
// ─────────────────────────────────────────
function showLoading(visible) {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  el.classList.toggle('hidden', !visible);
}

// ─────────────────────────────────────────
// エラーバナー
// ─────────────────────────────────────────
function showErrorBanner(message, type = 'error') {
  const banner = document.getElementById('model-error-banner');
  const text   = document.getElementById('model-error-banner-text');
  if (!banner || !text) return;
  text.textContent = message;
  banner.dataset.type = type;
  banner.classList.remove('hidden');
}

function hideErrorBanner() {
  const banner = document.getElementById('model-error-banner');
  if (banner) banner.classList.add('hidden');
}

// ─────────────────────────────────────────
// 進捗・スコア表示
// ─────────────────────────────────────────
function updateProgress() {
  const el = document.getElementById('progress-text');
  if (el) el.textContent = `${AppState.index + 1} / ${MAX_QUESTIONS}もん`;

  const bar = document.getElementById('progress-bar');
  if (bar) bar.style.width = `${(AppState.index / MAX_QUESTIONS) * 100}%`;

  const score = document.getElementById('score-display');
  if (score) score.textContent = `⭐ ${AppState.score}`;
}

// ─────────────────────────────────────────
// ヒントメッセージ
// ─────────────────────────────────────────
function updateHintMsg(problem) {
  const el = document.getElementById('hint-msg');
  if (!el) return;

  const count = Array.isArray(problem.hintLines) ? problem.hintLines.length : 0;
  if (count > 0) {
    el.textContent = `さいしょの ${count} ほんは かいてあるよ！`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ─────────────────────────────────────────
// オーバーレイ上限管理 (BUG-A 修正済み)
// ─────────────────────────────────────────
function _refreshOverlayLimit(problem) {
  const overlay = document.getElementById('canvas-overlay');
  if (!overlay) return;

  // Lv2/Lv3 は常にオーバーレイを表示（線数無制限）
  if (AppState.level >= 2) {
    overlay.classList.remove('hidden');
    return;
  }

  // Lv0/Lv1 は解答線が上限に達したら描画を止める
  const userLines  = getAnswerLines ? getAnswerLines() : [];
  const hintCount  = Array.isArray(problem.hintLines) ? problem.hintLines.length : 0;
  const totalLines = problem.lines ? problem.lines.length : 0;
  const limit      = totalLines - hintCount;

  if (userLines.length >= limit) {
    overlay.classList.add('hidden');
  } else {
    overlay.classList.remove('hidden');
  }
}

// ─────────────────────────────────────────
// 正解判定
// ─────────────────────────────────────────
function judgeAnswer(problem, userLines) {
  const norm = l => {
    const p1 = `${l.x1},${l.y1}`;
    const p2 = `${l.x2},${l.y2}`;
    return p1 <= p2 ? `${p1}-${p2}` : `${p2}-${p1}`;
  };

  const hintLines  = Array.isArray(problem.hintLines) ? problem.hintLines : [];
  const allLines   = [...hintLines, ...userLines];
  const answerSet  = new Set(problem.lines.map(norm));
  const submittedSet = new Set(allLines.map(norm));

  if (submittedSet.size !== answerSet.size) return false;
  for (const key of answerSet) {
    if (!submittedSet.has(key)) return false;
  }
  return true;
}

// ─────────────────────────────────────────
// 問題読み込み
// ─────────────────────────────────────────
function loadQuestion(index) {
  AppState.index = index;
  const problem  = AppState.problems[index];
  if (!problem) return;

  updateProgress();
  updateHintMsg(problem);

  // キャンバス初期化
  if (typeof initCanvases === 'function') {
    initCanvases(problem, AppState.level);
  }

  _refreshOverlayLimit(problem);
}

// ─────────────────────────────────────────
// 回答チェック
// ─────────────────────────────────────────
function checkAnswer() {
  const problem   = AppState.problems[AppState.index];
  if (!problem) return;
  const userLines = typeof getAnswerLines === 'function' ? getAnswerLines() : [];
  const correct   = judgeAnswer(problem, userLines);

  const overlay = document.getElementById('feedback-overlay');
  if (overlay) overlay.classList.remove('hidden');

  if (correct) {
    AppState.score++;
    updateProgress();

    const wrongSection   = document.getElementById('feedback-wrong');
    const correctSection = document.getElementById('feedback-correct');
    if (wrongSection)   wrongSection.classList.add('hidden');
    if (correctSection) {
      correctSection.classList.remove('hidden');
      const praiseEl = document.getElementById('praise-msg');
      if (praiseEl) praiseEl.textContent = randomPraise();
    }
  } else {
    const wrongSection   = document.getElementById('feedback-wrong');
    const correctSection = document.getElementById('feedback-correct');
    if (correctSection) correctSection.classList.add('hidden');
    if (wrongSection)   wrongSection.classList.remove('hidden');

    // 不正解フィードバック描画
    if (typeof drawWrongFeedback === 'function') {
      const cvs = document.getElementById('canvas-wrong');
      if (cvs) drawWrongFeedback(cvs, problem, userLines);
    }
  }
}

// ─────────────────────────────────────────
// 次の問題へ
// ─────────────────────────────────────────
function nextQuestion() {
  const overlay = document.getElementById('feedback-overlay');
  if (overlay) overlay.classList.add('hidden');

  const next = AppState.index + 1;
  if (next >= MAX_QUESTIONS) {
    showResult();
  } else {
    loadQuestion(next);
  }
}

// ─────────────────────────────────────────
// 結果画面
// ─────────────────────────────────────────
function showResult() {
  showScreen('result');
  const el = document.getElementById('final-score');
  if (el) el.textContent = `${AppState.score} / ${MAX_QUESTIONS}もん せいかい！`;
}

// ─────────────────────────────────────────
// ゲーム開始 (Gemini API 呼び出し + フォールバック)
// ─────────────────────────────────────────
async function startGame() {
  const level = AppState.level;
  AppState.score = 0;
  AppState.index = 0;

  const apiKey = loadApiKey();
  AppState.apiKey = apiKey;

  // APIキー未設定 → ローカル問題に即フォールバック
  if (!apiKey) {
    AppState.problems = getProblems(level);
    showScreen('game');
    loadQuestion(0);
    return;
  }

  // モデルチェーン未設定のアラート
  if (!GeminiAPI.loadAdminChain()) {
    showErrorBanner(
      'AIモデルの優先順位が未設定です。管理者設定から設定してください。',
      'info'
    );
  }

  // Gemini 生成（20 秒タイムアウト）
  showLoading(true);
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), 20000)
    );
    const result = await Promise.race([
      GeminiAPI.generateProblems(level),
      timeoutPromise,
    ]);

    geminiStatusUpdate(result);

    AppState.problems = result.problems && result.problems.length >= MAX_QUESTIONS
      ? result.problems.slice(0, MAX_QUESTIONS)
      : getProblems(level);

  } catch (err) {
    if (err.message === 'TIMEOUT') {
      showErrorBanner('AI生成がタイムアウトしました。ローカル問題を使用します。', 'error');
    } else {
      showErrorBanner('AI生成でエラーが発生しました。ローカル問題を使用します。', 'error');
    }
    AppState.problems = getProblems(level);
  } finally {
    showLoading(false);
  }

  showScreen('game');
  loadQuestion(0);
}

// ─────────────────────────────────────────
// Gemini ステータス更新
// ─────────────────────────────────────────
function geminiStatusUpdate(result) {
  if (!result) return;
  const { alertType, validCount } = result;

  if (alertType === 'error') {
    showErrorBanner(
      `AIが有効な問題を生成できませんでした（有効数: ${validCount}）。ローカル問題を使用します。`,
      'error'
    );
  } else if (alertType === 'warn') {
    showErrorBanner(
      `AI生成問題が不足しています（有効数: ${validCount}）。一部ローカル問題で補完しました。`,
      'info'
    );
  }
}

// ─────────────────────────────────────────
// DOMContentLoaded
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // --- レベルボタン ---
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
      document.getElementById('btn-start').disabled = false;
    });
  });

  // --- スタートボタン ---
  document.getElementById('btn-start').addEventListener('click', () => {
    startGame();
  });

  // --- APIキーパネル ---
  const savedKey = loadApiKey();
  if (savedKey) {
    const inputEl = document.getElementById('api-key-input');
    if (inputEl) inputEl.value = savedKey;
  }

  document.getElementById('btn-save-api-key')?.addEventListener('click', () => {
    const inputEl = document.getElementById('api-key-input');
    const key = inputEl ? inputEl.value.trim() : '';
    saveApiKey(key);
    hideErrorBanner();
    if (!key) {
      showErrorBanner(
        'Gemini APIキーが未設定です。管理者設定からキーを入力してください。',
        'info'
      );
    } else if (!GeminiAPI.loadAdminChain()) {
      showErrorBanner(
        'AIモデルの優先順位が未設定です。管理者設定から設定してください。',
        'info'
      );
    }
  });

  // --- 管理者リンク ---
  document.getElementById('btn-admin')?.addEventListener('click', () => {
    window.open('admin.html', '_blank');
  });

  // --- バナー閉じボタン ---
  const bannerCloseBtn = document.getElementById('model-error-banner-close');
  if (bannerCloseBtn) {
    bannerCloseBtn.addEventListener('click', e => {
      e.stopPropagation();
      hideErrorBanner();
    });
  }

  // --- バナー本体クリック → admin.html ---
  const banner = document.getElementById('model-error-banner');
  if (banner) {
    banner.addEventListener('click', () => {
      window.open('admin.html', '_blank');
    });
  }

  // --- ゲームコントロール ---
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (typeof clearAnswerLines === 'function') clearAnswerLines();
    const problem = AppState.problems[AppState.index];
    if (problem && typeof drawAnswer === 'function') drawAnswer(problem, AppState.level);
    if (problem) _refreshOverlayLimit(problem);
  });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (typeof undoLastLine === 'function') undoLastLine();
    const problem = AppState.problems[AppState.index];
    if (problem && typeof drawAnswer === 'function') drawAnswer(problem, AppState.level);
    if (problem) _refreshOverlayLimit(problem);
  });

  document.getElementById('btn-check')?.addEventListener('click', () => {
    checkAnswer();
  });

  document.getElementById('btn-next')?.addEventListener('click', () => {
    nextQuestion();
  });

  // --- リトライ ---
  document.getElementById('btn-retry')?.addEventListener('click', () => {
    AppState.score = 0;
    AppState.index = 0;
    startGame();
  });

  // --- ホーム ---
  document.getElementById('btn-home')?.addEventListener('click', () => {
    showScreen('start');
  });

  // --- デフォルトレベル選択 (Lv1) ---
  const defaultBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultBtn) defaultBtn.click();

  // ─────────────────────────────────────────────
  // BUG-F1 修正: setTimeout(block①) を削除し、
  // 以下の即時ブロック(block②) のみで初期バナーを制御
  // ─────────────────────────────────────────────
  if (!loadApiKey()) {
    showErrorBanner(
      'Gemini APIキーが未設定です。管理者設定からキーを入力してください。',
      'info'
    );
  } else if (!GeminiAPI.loadAdminChain()) {
    showErrorBanner(
      'AIモデルの優先順位が未設定です。管理者設定から設定してください。',
      'info'
    );
  }

}); // DOMContentLoaded end
