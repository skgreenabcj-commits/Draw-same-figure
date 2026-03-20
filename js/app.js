/**
 * app.js
 * メインアプリケーションロジック
 */

/* ============================================================
   アプリ状態
   ============================================================ */
const AppState = {
  level:        1,
  problems:     [],
  currentIndex: 0,
  score:        0,
  useAI:        false,
  apiKey:       ''
};

/* ============================================================
   褒め言葉リスト
   ============================================================ */
const PRAISE_LIST = [
  'すごい！ぴったり！',
  'かんぺき！！ 🎉',
  'やったね！ばっちり！',
  'さすが！！ 天才！',
  'せいかい！よくできました！',
  'ナイス！！ かっこいい！',
  'おみごと！！ 🌟',
  'すばらしい！！'
];

function randomPraise() {
  return PRAISE_LIST[Math.floor(Math.random() * PRAISE_LIST.length)];
}

/* ============================================================
   画面切り替え
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ============================================================
   正誤判定
   ============================================================ */
function judgeAnswer(problem, userLines) {
  const correct = problem.lines;
  const hint    = problem.hintLines || [];
  const allUserLines = [...hint, ...userLines];

  if (allUserLines.length !== correct.length) return false;

  const normalize = l => {
    return [
      `${l.x1},${l.y1}-${l.x2},${l.y2}`,
      `${l.x2},${l.y2}-${l.x1},${l.y1}`
    ].sort()[0];
  };

  const correctSet = new Set(correct.map(normalize));

  for (const line of allUserLines) {
    if (!correctSet.has(normalize(line))) return false;
  }

  const userSet = new Set(allUserLines.map(normalize));
  return userSet.size === correctSet.size;
}

/* ============================================================
   UI 更新
   ============================================================ */
function updateProgress() {
  const total = AppState.problems.length;
  const cur   = AppState.currentIndex + 1;
  document.getElementById('progress-text').textContent = `${cur} / ${total}もん`;
  document.getElementById('progress-bar').style.width  = `${(cur / total) * 100}%`;
  document.getElementById('score-text').textContent    = `⭐ ${AppState.score}`;
}

function updateHintMsg(problem) {
  const hintEl = document.getElementById('hint-msg');
  if (problem.level !== 1) {
    hintEl.classList.add('hidden');
    return;
  }
  const totalLines = problem.lines.length;
  const hintCount  = (problem.hintLines || []).length;
  const remain     = totalLines - hintCount;
  document.getElementById('hint-remain').textContent = remain;
  hintEl.classList.remove('hidden');
}

/* ============================================================
   問題ロード
   ★ 画面表示後に2フレーム待機してレイアウト確定後に描画
   ============================================================ */
function loadQuestion(index) {
  const problem = AppState.problems[index];
  AppState.currentIndex = index;

  updateProgress();
  initCanvases(problem);
  updateHintMsg(problem);

  // 2フレーム待機: aspect-ratio などの CSS レイアウト計算完了を待つ
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawModel(problem);
      drawAnswer(problem);

      setupInteraction(problem, (lineCount) => {
        if (problem.level === 1) {
          const maxLines = problem.lines.length - (problem.hintLines || []).length;
          const ov = document.getElementById('canvas-overlay');
          if (lineCount >= maxLines) {
            ov.style.pointerEvents = 'none';
            ov.style.cursor = 'not-allowed';
          } else {
            ov.style.pointerEvents = 'auto';
            ov.style.cursor = 'crosshair';
          }
        }
      });

      // 制限をリセット（setupInteraction 後）
      const ov = document.getElementById('canvas-overlay');
      ov.style.pointerEvents = 'auto';
      ov.style.cursor = 'crosshair';
    });
  });
}

/* ============================================================
   こたえあわせ
   ============================================================ */
function checkAnswer() {
  const problem   = AppState.problems[AppState.currentIndex];
  const userLines = getAnswerLines();
  const isCorrect = judgeAnswer(problem, userLines);

  const overlay = document.getElementById('feedback-overlay');
  overlay.classList.remove('hidden');

  if (isCorrect) {
    AppState.score++;
    document.getElementById('score-text').textContent = `⭐ ${AppState.score}`;
    document.getElementById('feedback-wrong').classList.add('hidden');
    document.getElementById('feedback-correct').classList.remove('hidden');
    document.getElementById('praise-text').textContent = randomPraise();
    // アニメーションをリセットして再生
    const img = document.querySelector('.gotit-img');
    img.style.animation = 'none';
    img.offsetHeight; // reflow
    img.style.animation = '';
  } else {
    document.getElementById('feedback-correct').classList.add('hidden');
    document.getElementById('feedback-wrong').classList.remove('hidden');
    drawWrongFeedback(problem, userLines);
  }
}

/* ============================================================
   次の問題 / 結果画面
   ============================================================ */
function goNext() {
  document.getElementById('feedback-overlay').classList.add('hidden');

  const next = AppState.currentIndex + 1;
  if (next >= AppState.problems.length) {
    showResult();
  } else {
    loadQuestion(next);
  }
}

function showResult() {
  showScreen('screen-result');
  const score = AppState.score;
  const total = AppState.problems.length;
  document.getElementById('final-score').textContent = score;

  let msg = '';
  if (score === total) {
    msg = '全問正解！！ あなたは天才です！🎉';
  } else if (score >= total * 0.8) {
    msg = 'とてもよくできました！もう少しで満点！';
  } else if (score >= total * 0.6) {
    msg = 'よくがんばりました！もう一度チャレンジしよう！';
  } else {
    msg = 'むずかしかったね。また練習してみよう！';
  }
  document.getElementById('result-msg').textContent = msg;
}

/* ============================================================
   ゲーム開始
   ★ showScreen 後に2フレーム待機してからキャンバスを描画
   ============================================================ */
async function startGame() {
  const level  = AppState.level;
  const apiKey = AppState.apiKey;

  if (apiKey) {
    showLoading(true);
    try {
      AppState.problems = await generateProblems(level, 5, apiKey);
    } catch (e) {
      console.warn('AI生成失敗、内蔵問題を使用:', e.message);
      alert(`AI問題生成エラー:\n${e.message}\n\n内蔵問題を使用します。`);
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

  // 画面遷移後、CSS レイアウト（aspect-ratio 等）が確定してから描画
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      loadQuestion(0);
    });
  });
}

/* ============================================================
   ローディング表示
   ============================================================ */
function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

/* ============================================================
   イベントバインド
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  /* ---- スタート画面 ---- */

  // レベルボタン
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
      document.getElementById('btn-start').disabled = false;
    });
  });

  // はじめるボタン
  document.getElementById('btn-start').addEventListener('click', () => {
    startGame();
  });

  // API Key トグル
  document.getElementById('btn-toggle-api').addEventListener('click', () => {
    document.getElementById('api-key-panel').classList.toggle('hidden');
  });

  // API Key 保存
  document.getElementById('btn-save-api').addEventListener('click', () => {
    const key = document.getElementById('input-api-key').value.trim();
    if (key) {
      saveApiKey(key);
      AppState.apiKey = key;
      alert('APIキーを保存しました。次回からAI問題生成が有効になります。');
    } else {
      saveApiKey('');
      AppState.apiKey = '';
      alert('APIキーをクリアしました。');
    }
  });

  // 保存済みAPIキーを読み込む
  const savedKey = loadApiKey();
  if (savedKey) {
    AppState.apiKey = savedKey;
    document.getElementById('input-api-key').value = savedKey;
  }

  /* ---- ゲーム画面 ---- */

  // ホームボタン
  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('ホームに戻りますか？（進捗は失われます）')) {
      showScreen('screen-start');
    }
  });

  // けすボタン
  document.getElementById('btn-clear').addEventListener('click', () => {
    clearAnswerLines();
    const ov = document.getElementById('canvas-overlay');
    ov.style.pointerEvents = 'auto';
    ov.style.cursor = 'crosshair';
  });

  // もどすボタン
  document.getElementById('btn-undo').addEventListener('click', () => {
    undoLastLine();
    const ov = document.getElementById('canvas-overlay');
    ov.style.pointerEvents = 'auto';
    ov.style.cursor = 'crosshair';
  });

  // こたえあわせボタン
  document.getElementById('btn-check').addEventListener('click', () => {
    checkAnswer();
  });

  // 不正解 → 次へ
  document.getElementById('btn-next-wrong').addEventListener('click', goNext);

  // 正解 → 次へ
  document.getElementById('btn-next-correct').addEventListener('click', goNext);

  /* ---- 結果画面 ---- */

  // もういちど
  document.getElementById('btn-retry').addEventListener('click', () => {
    startGame();
  });

  // ホームへ
  document.getElementById('btn-result-home').addEventListener('click', () => {
    showScreen('screen-start');
  });

  /* ---- 初期レベル選択（Level1 をデフォルト選択） ---- */
  const defaultLvBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultLvBtn) {
    defaultLvBtn.classList.add('selected');
    AppState.level = 1;
    document.getElementById('btn-start').disabled = false;
  }
});
