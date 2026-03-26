/* ============================================================
   app.js  v3.1  ―  BUG-1/2/3 修正版
   ============================================================ */

/* ---------- 定数 ---------- */
const GEMINI_TIMEOUT_MS  = 20000;

/* ---------- アプリ状態 ---------- */
const AppState = {
  level        : 1,
  problems     : [],
  currentIndex : 0,
  score        : 0,
  apiKey       : ''
};

/* ---------- 称賛メッセージ ---------- */
const PRAISE_LIST = [
  'すごい！ぴったり！','かんぺき！！ 🎉','やったね！ばっちり！','さすが！！ てんさい！',
  'せいかい！よくできました！','かっこいい！','おみごと！！ 🌟','すばらしい！！'
];
function randomPraise() {
  return PRAISE_LIST[Math.floor(Math.random() * PRAISE_LIST.length)];
}

/* ============================================================
   画面切り替え
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/* ============================================================
   ローディング
   ============================================================ */
function showLoading(show) {
  const el = document.getElementById('loading-overlay');
  if (el) el.classList.toggle('hidden', !show);
}

/* ============================================================
   エラーバナー
   ============================================================ */
function showErrorBanner(message, type = 'error') {
  const banner  = document.getElementById('model-error-banner');
  const textEl  = document.getElementById('model-error-banner-text');
  if (!banner) return;
  if (textEl) {
    textEl.textContent = type === 'error'
      ? `⚠️ AI: ${message}　（タップして管理者設定）`
      : `💡 ${message}　（タップして管理者設定）`;
  }
  banner.className = `model-error-banner model-error-banner--${type}`;
  banner.classList.remove('hidden');
}

function hideErrorBanner() {
  const el = document.getElementById('model-error-banner');
  if (el) el.classList.add('hidden');
}

/* ============================================================
   進捗・スコア表示
   ============================================================ */
function updateProgress() {
  const total = AppState.problems.length;
  const cur   = AppState.currentIndex + 1;
  const pt = document.getElementById('progress-text');
  const pb = document.getElementById('progress-bar');
  const st = document.getElementById('score-text');
  if (pt) pt.textContent = `${cur} / ${total}もん`;
  if (pb) pb.style.width = `${(cur / total) * 100}%`;
  if (st) st.textContent = `⭐ ${AppState.score}`;
}

/* ============================================================
   ヒントメッセージ
   ============================================================ */
function updateHintMsg(problem) {
  const hintEl = document.getElementById('hint-msg');
  if (!hintEl) return;
  if (problem.level !== 0 && problem.level !== 1) {
    hintEl.classList.add('hidden');
    return;
  }
  const remain = problem.lines.length - (problem.hintLines || []).length;
  const rEl = document.getElementById('hint-remain');
  if (rEl) rEl.textContent = remain;
  hintEl.classList.remove('hidden');
}

/* ============================================================
   線数上限管理
   ============================================================ */
function _refreshOverlayLimit(problem, lineCount) {
  const ov = document.getElementById('canvas-overlay');
  if (!ov) return;
  if (problem.level !== 0 && problem.level !== 1) {
    ov.classList.add('hidden');
    return;
  }
  const maxLines = problem.lines.length - (problem.hintLines || []).length;
  if (lineCount >= maxLines) {
    ov.classList.remove('hidden');
  } else {
    ov.classList.add('hidden');
  }
}

/* ============================================================
   判定
   ============================================================ */
function judgeAnswer(problem, userLines) {
  const correct = problem.lines;
  const hint    = problem.hintLines || [];
  const allUser = [...hint, ...userLines];
  if (allUser.length !== correct.length) return false;
  const norm = l => [
    `${Math.min(l.x1,l.x2)},${Math.min(l.y1,l.y2)}`,
    `${Math.max(l.x1,l.x2)},${Math.max(l.y1,l.y2)}`
  ].join('-');
  const correctSet = new Set(correct.map(norm));
  for (const line of allUser) {
    if (!correctSet.has(norm(line))) return false;
  }
  return new Set(allUser.map(norm)).size === correctSet.size;
}

/* ============================================================
   問題読み込み
   ============================================================ */
function loadQuestion(index) {
  const problem = AppState.problems[index];
  if (!problem) {
    console.error('loadQuestion: problem undefined at index', index,
                  'problems:', AppState.problems);
    return;
  }
  AppState.currentIndex = index;
  updateProgress();
  updateHintMsg(problem);
  initCanvases(problem);
  buildGridHeaders(problem);

  setTimeout(() => {
    requestAnimationFrame(() => {
      drawModel(problem);
      drawAnswer(problem);
      setupInteraction(problem, (lineCount) => {
        _refreshOverlayLimit(problem, lineCount);
      });
      _refreshOverlayLimit(problem, 0);
    });
  }, 0);
}

/* ============================================================
   答え合わせ
   ============================================================ */
function checkAnswer() {
  const problem = AppState.problems[AppState.currentIndex];
  if (!problem) return;
  const userLines = getAnswerLines();
  const isCorrect = judgeAnswer(problem, userLines);

  const overlay = document.getElementById('feedback-overlay');
  if (overlay) overlay.classList.remove('hidden');

  if (isCorrect) {
    AppState.score++;
    const st = document.getElementById('score-text');
    if (st) st.textContent = `⭐ ${AppState.score}`;
    document.getElementById('feedback-wrong')?.classList.add('hidden');
    document.getElementById('feedback-correct')?.classList.remove('hidden');
    const pt = document.getElementById('praise-text');
    if (pt) pt.textContent = randomPraise();
    const img = document.querySelector('.gotit-img');
    if (img) { img.style.animation = 'none'; img.offsetHeight; img.style.animation = ''; }
  } else {
    document.getElementById('feedback-correct')?.classList.add('hidden');
    document.getElementById('feedback-wrong')?.classList.remove('hidden');
    if (typeof drawWrongFeedback === 'function') {
      drawWrongFeedback(problem, userLines);
    }
  }
}

/* ============================================================
   次の問題へ
   ============================================================ */
function goNext() {
  document.getElementById('feedback-overlay')?.classList.add('hidden');
  const next = AppState.currentIndex + 1;
  if (next >= AppState.problems.length) showResult();
  else loadQuestion(next);
}

/* ============================================================
   結果画面
   ============================================================ */
function showResult() {
  showScreen('screen-result');
  const score = AppState.score;
  const total = AppState.problems.length;
  const fs = document.getElementById('final-score');
  if (fs) fs.textContent = score;
  const rm = document.getElementById('result-msg');
  if (rm) {
    if (score === total)           rm.textContent = 'ぜんぶせいかい！！ あなたはてんさい！🎉';
    else if (score >= total * 0.8) rm.textContent = 'とてもよくできました！';
    else if (score >= total * 0.6) rm.textContent = 'よくがんばりました！';
    else                           rm.textContent = 'がんばった！またあそぼう！！';
  }
}

/* ============================================================
   ゲーム開始  ★ BUG-1/2/3 修正箇所
   ============================================================ */
async function startGame() {
  const level = AppState.level;
  showLoading(true);
  hideErrorBanner();

  let problems = null;

  /* ── Gemini 生成（APIキーがある場合のみ） ── */
  const apiKey = (typeof loadApiKey === 'function') ? loadApiKey() : AppState.apiKey;
  if (apiKey) {
    try {
      const result = await Promise.race([
        generateProblems(level),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('timeout')), GEMINI_TIMEOUT_MS)
        ),
      ]);
      /* ★ BUG-2修正: generateProblems はオブジェクトを返す */
      if (result && Array.isArray(result.problems) && result.problems.length > 0) {
        problems = result.problems;
        if (result.alertType) {
          showErrorBanner(
            result.alertType === 'MODEL'  ? 'AIモデルを変更してください' :
            result.alertType === 'PROMPT' ? 'AI出力が不正です。管理者設定を確認してください' :
            result.alertType === 'LEVEL'  ? '有効な問題数が少ないです' :
            result.alertType,
            'error'
          );
        }
      } else if (Array.isArray(result) && result.length > 0) {
        problems = result; // 万が一配列で返った場合の保険
      }
    } catch (e) {
      console.warn('Gemini 失敗:', e.message);
      showErrorBanner('AI生成に失敗しました。ローカル問題を使用します。', 'info');
    }
  }

  /* ── ★ BUG-1/3修正: ローカル問題フォールバック ──
   * LOCAL_PROBLEMS は存在しないため getProblems() を使用する */
  if (!problems || !problems.length) {
    if (typeof getProblems === 'function') {
      problems = getProblems(level);
    }
  }

  showLoading(false);

  if (!problems || !problems.length) {
    showErrorBanner('問題を取得できませんでした。');
    return;
  }

  AppState.problems     = problems;
  AppState.score        = 0;
  AppState.currentIndex = 0;

  showScreen('screen-game');
  setTimeout(() => {
    requestAnimationFrame(() => {
      loadQuestion(0);
    });
  }, 0);
}

/* ============================================================
   Gemini ステータス更新コールバック
   ============================================================ */
function geminiStatusUpdate(status) {
  if (!status) return;
  if (status.alertType) {
    showErrorBanner(status.message || status.alertType);
  } else {
    hideErrorBanner();
  }
}

/* ============================================================
   DOMContentLoaded
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  /* レベル選択 */
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
      const sb = document.getElementById('btn-start');
      if (sb) sb.disabled = false;
    });
  });

  /* はじめる */
  document.getElementById('btn-start')
    ?.addEventListener('click', startGame);

  /* APIキー */
  document.getElementById('btn-toggle-api')
    ?.addEventListener('click', () => {
      document.getElementById('api-key-panel')?.classList.toggle('hidden');
    });

  document.getElementById('btn-save-api')
    ?.addEventListener('click', () => {
      const input = document.getElementById('input-api-key');
      const key   = input ? input.value.trim() : '';
      if (key) {
        if (typeof saveApiKey === 'function') saveApiKey(key);
        AppState.apiKey = key;
        alert('APIキーを保存しました。');
      } else {
        if (typeof saveApiKey === 'function') saveApiKey('');
        AppState.apiKey = '';
        hideErrorBanner();
        alert('APIキーをクリアしました。');
      }
    });

  /* 保存済みAPIキーの読み込み */
  const savedKey = (typeof loadApiKey === 'function') ? loadApiKey() : '';
  if (savedKey) {
    AppState.apiKey = savedKey;
    const inputEl = document.getElementById('input-api-key');
    if (inputEl) inputEl.value = savedKey;
  }

  /* 管理者設定 */
  document.getElementById('btn-admin-model')
    ?.addEventListener('click', () => window.open('admin.html', '_blank'));
  document.getElementById('model-error-banner')
  ?.addEventListener('click', (e) => {
    if (!e.target.closest('#model-error-banner-close')) {
      window.open('admin.html', '_blank');
    }
  });
document.getElementById('model-error-banner-close')
  ?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideErrorBanner();
  });

  /* ゲーム操作 */
  document.getElementById('btn-home')
    ?.addEventListener('click', () => {
      if (confirm('ホームに戻りますか？')) showScreen('screen-start');
    });

  document.getElementById('btn-clear')
    ?.addEventListener('click', () => {
      clearAnswerLines();
      const p = AppState.problems[AppState.currentIndex];
      if (p) _refreshOverlayLimit(p, 0);
    });

  document.getElementById('btn-undo')
    ?.addEventListener('click', () => {
      undoLastLine();
      const p   = AppState.problems[AppState.currentIndex];
      const cnt = getAnswerLines().length;
      if (p) _refreshOverlayLimit(p, cnt);
    });

  document.getElementById('btn-check')
    ?.addEventListener('click', checkAnswer);

  /* フィードバック */
  document.getElementById('btn-next-wrong')
    ?.addEventListener('click', goNext);
  document.getElementById('btn-next-correct')
    ?.addEventListener('click', goNext);

  /* 結果画面 */
  document.getElementById('btn-retry')
    ?.addEventListener('click', () => {
      AppState.score        = 0;
      AppState.currentIndex = 0;
      showScreen('screen-start');
    });
  document.getElementById('btn-result-home')
    ?.addEventListener('click', () => showScreen('screen-start'));

  /* geminiStatusUpdate イベント監視 */
  window.addEventListener('geminiStatusUpdate', (e) => {
    const status = e.detail;
    if (!status) return;
    if (status.alertType) showErrorBanner(status.lastError || status.alertType, 'error');
  });

  /* デフォルトレベル選択（Lv1） */
  const defaultLvBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultLvBtn) {
    defaultLvBtn.classList.add('selected');
    AppState.level = 1;
    const sb = document.getElementById('btn-start');
    if (sb) sb.disabled = false;
  }

  /* 初回案内バナー */
  if (AppState.apiKey && typeof loadAdminChain === 'function' && !loadAdminChain()) {
    setTimeout(() =>
      showErrorBanner('AIモデルが未設定です。管理者設定から推奨モデルを選んでください。', 'info'),
      600
    );
  }
});
