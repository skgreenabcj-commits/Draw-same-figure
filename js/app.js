// ============================================================
// app.js  v3.5
//   BUG-1  : showScreen を .active クラス制御に修正
//   BUG-2  : loadQuestion に drawModel/drawAnswer/setupInteraction を追加
//   BUG-3  : drawWrongFeedback のシグネチャを canvas.js 定義に合わせる
//   BUG-4  : score-display → score-text
//   BUG-5  : praise-msg → praise-text
//   BUG-6  : btn-next → btn-next-wrong / btn-next-correct
//   BUG-7  : api-key-input → input-api-key
//   BUG-8  : btn-save-api-key → btn-save-api
//   BUG-9  : btn-admin → btn-admin-model
//   BUG-10 : btn-result-home リスナー追加
//   BUG-11 : btn-toggle-api リスナー追加（APIキーパネル開閉）
//   BUG-12 : final-score には数字のみ書込み
//   ESC-01 : GeminiAPI 参照を typeof ガードで保護（維持）
//   ESC-02 : btn-start / btn-retry 多重起動防止（維持）
// ============================================================

'use strict';

// ─────────────────────────────────────────
// 定数
// ─────────────────────────────────────────
const STORAGE_KEY_API = 'gemini_api_key';
const MAX_QUESTIONS   = 5;
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

// 多重起動防止フラグ (ESC-02)
let _gameStarting = false;

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
// 画面切り替え (BUG-1 修正: .active クラスで制御)
// ─────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.add('active');
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
  text.textContent    = message;
  banner.dataset.type = type;
  banner.classList.remove('hidden');
}

function hideErrorBanner() {
  const banner = document.getElementById('model-error-banner');
  if (banner) banner.classList.add('hidden');
}

// ─────────────────────────────────────────
// 進捗・スコア表示 (BUG-4 修正: score-text)
// ─────────────────────────────────────────
function updateProgress() {
  const el = document.getElementById('progress-text');
  if (el) el.textContent = `${AppState.index + 1} / ${MAX_QUESTIONS}もん`;

  const bar = document.getElementById('progress-bar');
  if (bar) bar.style.width = `${(AppState.index / MAX_QUESTIONS) * 100}%`;

  // BUG-4 修正: 'score-display' → 'score-text'
  const score = document.getElementById('score-text');
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

  // Lv0/Lv1 はユーザー解答線が上限に達したら描画を止める
  const userLines  = typeof getAnswerLines === 'function' ? getAnswerLines() : [];
  const hintCount  = Array.isArray(problem.hintLines) ? problem.hintLines.length : 0;
  const totalLines = Array.isArray(problem.lines) ? problem.lines.length : 0;
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

  const hintLines    = Array.isArray(problem.hintLines) ? problem.hintLines : [];
  const allLines     = [...hintLines, ...userLines];
  const answerSet    = new Set((problem.lines || []).map(norm));
  const submittedSet = new Set(allLines.map(norm));

  if (submittedSet.size !== answerSet.size) return false;
  for (const key of answerSet) {
    if (!submittedSet.has(key)) return false;
  }
  return true;
}

// ─────────────────────────────────────────
// 問題読み込み
// (BUG-2 修正: initCanvases後に drawModel/drawAnswer/setupInteraction を呼ぶ)
// ─────────────────────────────────────────
function loadQuestion(index) {
  AppState.index = index;
  const problem  = AppState.problems[index];
  if (!problem) return;

  updateProgress();
  updateHintMsg(problem);

  // BUG-2 修正:
  //   initCanvases はリセットのみ（canvas を 1×1 に縮小）。
  //   描画は drawModel / drawAnswer / setupInteraction を明示的に呼ぶ必要がある。
  //   showScreen 後のリフロー確定を待つため requestAnimationFrame を2段ネスト。
  if (typeof initCanvases === 'function') {
    initCanvases(problem);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (typeof drawModel       === 'function') drawModel(problem);
      if (typeof drawAnswer      === 'function') drawAnswer(problem);
      if (typeof setupInteraction === 'function') {
        setupInteraction(problem, (lineCount) => {
          // 線が追加されるたびにオーバーレイ上限を再チェック
          _refreshOverlayLimit(problem);
        });
      }
      _refreshOverlayLimit(problem);
    });
  });
}

// ─────────────────────────────────────────
// 回答チェック
// (BUG-3 修正: drawWrongFeedback のシグネチャを canvas.js に合わせる)
// (BUG-5 修正: praise-text)
// ─────────────────────────────────────────
function checkAnswer() {
  const problem = AppState.problems[AppState.index];
  if (!problem) return;

  const userLines = typeof getAnswerLines === 'function' ? getAnswerLines() : [];
  const correct   = judgeAnswer(problem, userLines);

  const overlay = document.getElementById('feedback-overlay');
  if (overlay) overlay.classList.remove('hidden');

  const wrongSection   = document.getElementById('feedback-wrong');
  const correctSection = document.getElementById('feedback-correct');

  if (correct) {
    AppState.score++;
    updateProgress();
    if (wrongSection)   wrongSection.classList.add('hidden');
    if (correctSection) {
      correctSection.classList.remove('hidden');
      // BUG-5 修正: 'praise-msg' → 'praise-text'
      const praiseEl = document.getElementById('praise-text');
      if (praiseEl) praiseEl.textContent = randomPraise();
    }
  } else {
    if (correctSection) correctSection.classList.add('hidden');
    if (wrongSection)   wrongSection.classList.remove('hidden');

    // BUG-3 修正: canvas.js の drawWrongFeedback(problem, userLines) に合わせる
    // 旧: drawWrongFeedback(cvs, problem, userLines)  ← 第1引数にDOM要素を渡していた
    // 新: drawWrongFeedback(problem, userLines)       ← canvas は内部で getElementById
    if (typeof drawWrongFeedback === 'function') {
      drawWrongFeedback(problem, userLines);
    }
  }
}

// ─────────────────────────────────────────
// 次の問題へ (BUG-6 修正: btn-next-wrong / btn-next-correct で登録)
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
// 結果画面 (BUG-12 修正: final-score に数字のみ書込み)
// ─────────────────────────────────────────
function showResult() {
  showScreen('result');
  // BUG-12 修正: HTML は <span id="final-score">0</span> / 5もん の構造。
  // 数字のみを書き込む。文章は HTML 側に固定されている。
  const el = document.getElementById('final-score');
  if (el) el.textContent = String(AppState.score);
}

// ─────────────────────────────────────────
// ゲーム開始 (ESC-01: GeminiAPI を typeof ガードで保護)
// ─────────────────────────────────────────
async function startGame() {
  const level = AppState.level;
  AppState.score    = 0;
  AppState.index    = 0;
  AppState.problems = [];

  const apiKey = loadApiKey();
  AppState.apiKey = apiKey;

  // ── APIキー未設定 → ローカル問題に即フォールバック ──
  if (!apiKey) {
    AppState.problems = getProblems(level);
    showScreen('game');
    loadQuestion(0);
    return;
  }

  // ── ESC-01: GeminiAPI 存在確認 ──
  const geminiAvailable = typeof GeminiAPI !== 'undefined';

  // モデルチェーン未設定のアラート
  if (geminiAvailable && !GeminiAPI.loadAdminChain()) {
    showErrorBanner(
      'AIモデルの優先順位が未設定です。管理者設定から設定してください。',
      'info'
    );
  }

  // GeminiAPI が利用不可の場合は即フォールバック
  if (!geminiAvailable) {
    showErrorBanner(
      'AI機能を読み込めませんでした。ローカル問題を使用します。',
      'error'
    );
    AppState.problems = getProblems(level);
    showScreen('game');
    loadQuestion(0);
    return;
  }

  // ── Gemini 生成（20 秒タイムアウト）──
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

    AppState.problems =
      result && result.problems && result.problems.length >= MAX_QUESTIONS
        ? result.problems.slice(0, MAX_QUESTIONS)
        : getProblems(level);

  } catch (err) {
    if (err.message === 'TIMEOUT') {
      showErrorBanner(
        'AI生成がタイムアウトしました。ローカル問題を使用します。',
        'error'
      );
    } else {
      showErrorBanner(
        'AI生成でエラーが発生しました。ローカル問題を使用します。',
        'error'
      );
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

  // ── レベルボタン ──
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
      document.getElementById('btn-start').disabled = false;
    });
  });

  // ── スタートボタン (ESC-02: 多重起動防止) ──
  document.getElementById('btn-start').addEventListener('click', async () => {
    if (_gameStarting) return;
    _gameStarting = true;
    document.getElementById('btn-start').disabled = true;
    try {
      await startGame();
    } finally {
      _gameStarting = false;
    }
  });

  // ── APIキーパネル開閉 (BUG-11 修正: btn-toggle-api) ──
  document.getElementById('btn-toggle-api')?.addEventListener('click', () => {
    const panel = document.getElementById('api-key-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
  });

  // ── APIキー保存 (BUG-7/8 修正: input-api-key / btn-save-api) ──
  const savedKey = loadApiKey();
  if (savedKey) {
    // BUG-7 修正: 'api-key-input' → 'input-api-key'
    const inputEl = document.getElementById('input-api-key');
    if (inputEl) inputEl.value = savedKey;
  }

  // BUG-8 修正: 'btn-save-api-key' → 'btn-save-api'
  document.getElementById('btn-save-api')?.addEventListener('click', () => {
    // BUG-7 修正: 'api-key-input' → 'input-api-key'
    const inputEl = document.getElementById('input-api-key');
    const key = inputEl ? inputEl.value.trim() : '';
    saveApiKey(key);
    hideErrorBanner();

    if (!key) {
      showErrorBanner(
        'Gemini APIキーが未設定です。管理者設定からキーを入力してください。',
        'info'
      );
    } else if (
      typeof GeminiAPI !== 'undefined' &&
      !GeminiAPI.loadAdminChain()
    ) {
      showErrorBanner(
        'AIモデルの優先順位が未設定です。管理者設定から設定してください。',
        'info'
      );
    }
  });

  // ── 管理者リンク (BUG-9 修正: btn-admin-model) ──
  // BUG-9 修正: 'btn-admin' → 'btn-admin-model'
  document.getElementById('btn-admin-model')?.addEventListener('click', () => {
    window.open('admin.html', '_blank');
  });

  // ── バナー閉じボタン ──
  document.getElementById('model-error-banner-close')?.addEventListener('click', e => {
    e.stopPropagation();
    hideErrorBanner();
  });

  // ── バナー本体クリック → admin.html ──
  document.getElementById('model-error-banner')?.addEventListener('click', () => {
    window.open('admin.html', '_blank');
  });

  // ── ゲームコントロール ──
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (typeof clearAnswerLines === 'function') clearAnswerLines();
    const problem = AppState.problems[AppState.index];
    if (problem) {
      if (typeof drawAnswer === 'function') drawAnswer(problem);
      _refreshOverlayLimit(problem);
    }
  });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (typeof undoLastLine === 'function') undoLastLine();
    const problem = AppState.problems[AppState.index];
    if (problem) {
      if (typeof drawAnswer === 'function') drawAnswer(problem);
      _refreshOverlayLimit(problem);
    }
  });

  document.getElementById('btn-check')?.addEventListener('click', () => {
    checkAnswer();
  });

  // BUG-6 修正: 'btn-next' → 'btn-next-wrong' と 'btn-next-correct' それぞれに登録
  document.getElementById('btn-next-wrong')?.addEventListener('click', () => {
    nextQuestion();
  });
  document.getElementById('btn-next-correct')?.addEventListener('click', () => {
    nextQuestion();
  });

  // ── リトライ (ESC-02: 多重起動防止) ──
  document.getElementById('btn-retry')?.addEventListener('click', async () => {
    if (_gameStarting) return;
    _gameStarting = true;
    AppState.score = 0;
    AppState.index = 0;
    try {
      await startGame();
    } finally {
      _gameStarting = false;
    }
  });

  // ── ホーム（ゲーム内ヘッダー） ──
  document.getElementById('btn-home')?.addEventListener('click', () => {
    showScreen('start');
  });

  // BUG-10 修正: 結果画面の「ホームへ」ボタン (btn-result-home) を登録
  document.getElementById('btn-result-home')?.addEventListener('click', () => {
    showScreen('start');
  });

  // ── デフォルトレベル選択 (Lv1) ──
  const defaultBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultBtn) defaultBtn.click();

  // ──────────────────────────────────────────────────────────
  // BUG-F1 修正済み維持: 即時ブロックのみで初期バナーを制御
  // ESC-01: GeminiAPI 参照を typeof ガードで保護
  // ──────────────────────────────────────────────────────────
  if (!loadApiKey()) {
    showErrorBanner(
      'Gemini APIキーが未設定です。管理者設定からキーを入力してください。',
      'info'
    );
  } else if (
    typeof GeminiAPI !== 'undefined' &&
    !GeminiAPI.loadAdminChain()
  ) {
    showErrorBanner(
      'AIモデルの優先順位が未設定です。管理者設定から設定してください。',
      'info'
    );
  }

}); // DOMContentLoaded end
