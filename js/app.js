/**
 * app.js  v2.4R
 * 旧版 v2.4 をベースに以下を統合:
 *   - generateProblems の戻り値形式を { problems, validCount, alertType } に対応
 *   - loadQuestion の requestAnimationFrame 二重ネストを維持（差分6修正）
 *   - btn-next-wrong / btn-next-correct の2ボタン構造を維持（差分7修正）
 *   - showResult の旧版テキスト・IDを維持（差分8修正）
 *   - バナーは旧版のクラス制御方式を維持（差分9修正）
 */

const AppState = {
  level:        1,
  problems:     [],
  currentIndex: 0,
  score:        0,
  useAI:        false,
  apiKey:       ''
};

const PRAISE_LIST = [
  'すごい！ぴったり！','かんぺき！！ 🎉','やったね！ばっちり！','さすが！！ てんさい！',
  'せいかい！よくできました！','かっこいい！','おみごと！！ 🌟','すばらしい！！'
];
function randomPraise() { return PRAISE_LIST[Math.floor(Math.random() * PRAISE_LIST.length)]; }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ============================================================
   判定: ヒント線を含めた全線分が正解と一致するか
   ============================================================ */
function judgeAnswer(problem, userLines) {
  const correct = problem.lines;
  const hint    = problem.hintLines || [];
  const allUserLines = [...hint, ...userLines];
  if (allUserLines.length !== correct.length) return false;
  const normalize = l => [`${l.x1},${l.y1}-${l.x2},${l.y2}`, `${l.x2},${l.y2}-${l.x1},${l.y1}`].sort()[0];
  const correctSet = new Set(correct.map(normalize));
  for (const line of allUserLines) { if (!correctSet.has(normalize(line))) return false; }
  const userSet = new Set(allUserLines.map(normalize));
  return userSet.size === correctSet.size;
}

/* ============================================================
   進捗・スコア表示
   ============================================================ */
function updateProgress() {
  const total = AppState.problems.length;
  const cur   = AppState.currentIndex + 1;
  document.getElementById('progress-text').textContent = `${cur} / ${total}もん`;
  document.getElementById('progress-bar').style.width  = `${(cur / total) * 100}%`;
  document.getElementById('score-text').textContent    = `⭐ ${AppState.score}`;
}

/* ============================================================
   ヒントメッセージ
   ============================================================ */
function updateHintMsg(problem) {
  const hintEl = document.getElementById('hint-msg');
  if (problem.level !== 0 && problem.level !== 1) {
    hintEl.classList.add('hidden');
    return;
  }
  const remain = problem.lines.length - (problem.hintLines || []).length;
  document.getElementById('hint-remain').textContent = remain;
  hintEl.classList.remove('hidden');
}

/* ============================================================
   線数上限管理（Lv0・Lv1 のみ）
   ============================================================ */
function _refreshOverlayLimit(problem, lineCount) {
  const ov = document.getElementById('canvas-overlay');
  if (!ov) return;
  if (problem.level !== 0 && problem.level !== 1) {
    ov.style.pointerEvents = 'auto';
    ov.style.cursor        = 'crosshair';
    return;
  }
  const maxLines = problem.lines.length - (problem.hintLines || []).length;
  if (lineCount >= maxLines) {
    ov.style.pointerEvents = 'none';
    ov.style.cursor        = 'not-allowed';
  } else {
    ov.style.pointerEvents = 'auto';
    ov.style.cursor        = 'crosshair';
  }
}

/* ============================================================
   問題読み込み
   ============================================================ */
function loadQuestion(index) {
  const problem = AppState.problems[index];
  AppState.currentIndex = index;
  updateProgress();
  initCanvases(problem);
  updateHintMsg(problem);
  buildGridHeaders(problem);

  // 根本原因3 修正:
  // setTimeout(0) でレイアウトエンジンに制御を返し、
  // Flexレイアウト計算を完了させてから rAF で描画する。
  // rAF 二重ネストだけでは .canvas-wrap の clientWidth が
  // 0 のままになるケースがあるため setTimeout(0) を先行させる。
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
  const problem   = AppState.problems[AppState.currentIndex];
  const userLines = getAnswerLines();
  const isCorrect = judgeAnswer(problem, userLines);

  document.getElementById('feedback-overlay').classList.remove('hidden');

  if (isCorrect) {
    AppState.score++;
    document.getElementById('score-text').textContent = `⭐ ${AppState.score}`;
    document.getElementById('feedback-wrong').classList.add('hidden');
    document.getElementById('feedback-correct').classList.remove('hidden');
    document.getElementById('praise-text').textContent = randomPraise();
    // gotit.png のアニメーションをリセット
    const img = document.querySelector('.gotit-img');
    if (img) { img.style.animation = 'none'; img.offsetHeight; img.style.animation = ''; }
  } else {
    document.getElementById('feedback-correct').classList.add('hidden');
    document.getElementById('feedback-wrong').classList.remove('hidden');
    drawWrongFeedback(problem, userLines);
  }
}

/* ============================================================
   次の問題へ
   ============================================================ */
function goNext() {
  document.getElementById('feedback-overlay').classList.add('hidden');
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
  document.getElementById('final-score').textContent = score;
  let msg = '';
  if (score === total)           msg = 'ぜんぶせいかい！！ あなたはてんさい！🎉';
  else if (score >= total * 0.8) msg = 'とてもよくできました！';
  else if (score >= total * 0.6) msg = 'よくがんばりました！';
  else                           msg = 'がんばった！またあそぼう！！';
  document.getElementById('result-msg').textContent = msg;
}

/* ============================================================
   ゲーム開始
   ============================================================ */
/*
=== backup ===
async function startGame() {
  const level  = AppState.level;
  const apiKey = AppState.apiKey;

  if (apiKey) {
    showLoading(true);
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('タイムアウト')), 30000)
      );
      const result = await Promise.race([
        generateProblems(level, 5, apiKey),
        timeoutPromise
      ]);
      if (Array.isArray(result)) {
        AppState.problems = result;
      } else {
        AppState.problems = result.problems || [];
        if (result.alertType) {
          showErrorBanner(
            result.alertType === 'MODEL'  ? 'CHANGE AI model' :
            result.alertType === 'PROMPT' ? 'CHECK AI prompt or CHANGE AI model' :
            result.alertType === 'LEVEL'  ? 'CONSIDER changing the level limits' :
            result.alertType,
            'error'
          );
        }
      }
    } catch (e) {
      console.warn('AI生成失敗:', e.message);
      AppState.problems = getProblems(level);
    } finally {
      showLoading(false);
    }
  } else {
    AppState.problems = getProblems(level);
  }

  AppState.score        = 0;
  AppState.currentIndex = 0;
  showScreen('screen-game');

  // 根本原因3 修正:
  // rAF 二重ネストだけでは Flex レイアウト計算が完了しない場合があるため
  // setTimeout(0) でブラウザに制御を返してレイアウトを確定させてから
  // rAF で描画する
  setTimeout(() => {
    requestAnimationFrame(() => { loadQuestion(0); });
  }, 0);
}
*/
async function startGame() {
  const level = AppState.level;
  console.log('[1] startGame 開始, level:', level);
  showLoading(true);
  hideErrorBanner();

  let problems = null;

  const apiKey = (typeof getApiKey === 'function') ? getApiKey() : null;
  console.log('[2] apiKey:', apiKey ? '存在' : 'なし');

  if (apiKey) {
    try {
      problems = await Promise.race([
        generateProblems(level),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('timeout')), GEMINI_TIMEOUT_MS)
        ),
      ]);
      console.log('[3] Gemini結果:', problems);
    } catch (e) {
      console.warn('[3] Gemini失敗:', e.message);
    }
  }

  if (!problems || !problems.length) {
    console.log('[4] フォールバック開始');
    const raw = localStorage.getItem(LOCAL_PROBLEMS_KEY);
    if (raw) {
      try { problems = JSON.parse(raw); } catch { }
    }
    console.log('[4a] localStorage結果:', problems);

    if (!problems || !problems.length) {
      if (typeof LOCAL_PROBLEMS !== 'undefined' && Array.isArray(LOCAL_PROBLEMS)) {
        problems = LOCAL_PROBLEMS.filter(p => p.level === level);
        console.log('[4b] LOCAL_PROBLEMS filter結果:', problems?.length,
          '/ level比較:', typeof level, level,
          '/ 先頭のlevel型:', typeof LOCAL_PROBLEMS[0]?.level, LOCAL_PROBLEMS[0]?.level);
      } else {
        console.log('[4b] LOCAL_PROBLEMS が未定義またはArrayでない');
      }
    }
  }

  showLoading(false);

  console.log('[5] 最終problems:', problems?.length, problems);

  if (!problems || !problems.length) {
    showErrorBanner('問題を取得できませんでした。');
    return;
  }

  AppState.problems = problems;
  console.log('[6] AppState.problems 代入後:', AppState.problems.length);

  showScreen('screen-game');

  setTimeout(() => {
    requestAnimationFrame(() => {
      console.log('[7] loadQuestion直前 AppState.problems:', AppState.problems.length);
      loadQuestion(0);
    });
  }, 0);
}

/* ============================================================
   ローディング
   ============================================================ */
function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

/* ============================================================
   エラーバナー（旧版クラス制御方式）
   ============================================================ */
function showErrorBanner(message, type = 'error') {
  const banner = document.getElementById('model-error-banner');
  if (!banner) return;
  banner.textContent = type === 'error'
    ? `⚠️ AI: ${message}　（タップして管理者設定）`
    : `💡 ${message}　（タップして管理者設定）`;
  banner.className = `model-error-banner model-error-banner--${type}`;
  banner.classList.remove('hidden');
}

function hideErrorBanner() {
  const banner = document.getElementById('model-error-banner');
  if (banner) banner.classList.add('hidden');
}

/* ============================================================
   イベントバインド
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  /* スタート画面: レベル選択 */
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
      document.getElementById('btn-start').disabled = false;
    });
  });

  document.getElementById('btn-start').addEventListener('click', startGame);

  /* API キー */
  document.getElementById('btn-toggle-api').addEventListener('click', () => {
    document.getElementById('api-key-panel').classList.toggle('hidden');
  });
  document.getElementById('btn-save-api').addEventListener('click', () => {
    const key = document.getElementById('input-api-key').value.trim();
    if (key) {
      saveApiKey(key);
      AppState.apiKey = key;
      clearModelCache();
      alert('APIキーを保存しました。');
      if (!loadAdminChain()) {
        showErrorBanner('AIモデルが未設定です。管理者設定から推奨モデルを選んでください。', 'info');
      }
    } else {
      saveApiKey('');
      AppState.apiKey = '';
      clearModelCache();
      hideErrorBanner();
      alert('APIキーをクリアしました。');
    }
  });

  const savedKey = loadApiKey();
  if (savedKey) {
    AppState.apiKey = savedKey;
    document.getElementById('input-api-key').value = savedKey;
  }

  /* 管理者設定 */
  document.getElementById('btn-admin-model')
    ?.addEventListener('click', () => window.open('admin.html', '_blank'));
  document.getElementById('model-error-banner')
    ?.addEventListener('click', () => window.open('admin.html', '_blank'));

  /* ゲーム画面 */
  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('ホームに戻りますか？')) showScreen('screen-start');
  });
  document.getElementById('btn-clear').addEventListener('click', () => {
    clearAnswerLines();
    const problem = AppState.problems[AppState.currentIndex];
    if (problem) _refreshOverlayLimit(problem, 0);
  });
  document.getElementById('btn-undo').addEventListener('click', () => {
    undoLastLine();
    const problem   = AppState.problems[AppState.currentIndex];
    const lineCount = getAnswerLines().length;
    if (problem) _refreshOverlayLimit(problem, lineCount);
  });
  document.getElementById('btn-check').addEventListener('click', checkAnswer);

  /* フィードバック: 次へボタン（正解・不正解それぞれ） */
  document.getElementById('btn-next-wrong').addEventListener('click', goNext);
  document.getElementById('btn-next-correct').addEventListener('click', goNext);

  /* 結果画面 */
  document.getElementById('btn-retry').addEventListener('click', startGame);
  document.getElementById('btn-result-home').addEventListener('click', () => showScreen('screen-start'));

  /* geminiStatusUpdate 監視 */
  window.addEventListener('geminiStatusUpdate', (e) => {
    const status = e.detail;
    if (!status) return;
    if (status.lastError) showErrorBanner(status.lastError, 'error');
  });

  /* デフォルトレベル選択（Lv1） */
  const defaultLvBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultLvBtn) {
    defaultLvBtn.classList.add('selected');
    AppState.level = 1;
    document.getElementById('btn-start').disabled = false;
  }

  /* 初回案内バナー */
  if (AppState.apiKey && !loadAdminChain()) {
    setTimeout(() =>
      showErrorBanner('AIモデルが未設定です。管理者設定から推奨モデルを選んでください。', 'info'),
      600
    );
  }
});
