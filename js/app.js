/**
 * app.js
 * メインアプリケーションロジック
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
  'すごい！ぴったり！',
  'かんぺき！！ 🎉',
  'やったね！ばっちり！',
  'さすが！！ てんさい！',
  'せいかい！よくできました！',
  'かっこいい！',
  'おみごと！！ 🌟',
  'すばらしい！！'
];

function randomPraise() {
  return PRAISE_LIST[Math.floor(Math.random() * PRAISE_LIST.length)];
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function judgeAnswer(problem, userLines) {
  const correct = problem.lines;
  const hint    = problem.hintLines || [];
  const allUserLines = [...hint, ...userLines];

  if (allUserLines.length !== correct.length) return false;

  const normalize = l => [
    `${l.x1},${l.y1}-${l.x2},${l.y2}`,
    `${l.x2},${l.y2}-${l.x1},${l.y1}`
  ].sort()[0];

  const correctSet = new Set(correct.map(normalize));
  for (const line of allUserLines) {
    if (!correctSet.has(normalize(line))) return false;
  }

  const userSet = new Set(allUserLines.map(normalize));
  return userSet.size === correctSet.size;
}

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
  const remain = problem.lines.length - (problem.hintLines || []).length;
  document.getElementById('hint-remain').textContent = remain;
  hintEl.classList.remove('hidden');
}

/* ============================================================
   問題ロード
   ============================================================ */
function loadQuestion(index) {
  const problem = AppState.problems[index];
  AppState.currentIndex = index;

  updateProgress();
  initCanvases(problem);
  updateHintMsg(problem);

  // ★ グリッドヘッダーを構築（Lv1/Lv2のみ表示、Lv3は非表示）
  buildGridHeaders(problem);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawModel(problem);
      drawAnswer(problem);

      setupInteraction(problem, (lineCount) => {
        if (problem.level === 1) {
          const maxLines = problem.lines.length - (problem.hintLines || []).length;
          const ov = document.getElementById('canvas-overlay');
          ov.style.pointerEvents = lineCount >= maxLines ? 'none' : 'auto';
          ov.style.cursor        = lineCount >= maxLines ? 'not-allowed' : 'crosshair';
        }
      });

      const ov = document.getElementById('canvas-overlay');
      ov.style.pointerEvents = 'auto';
      ov.style.cursor = 'crosshair';
    });
  });
}

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
    const img = document.querySelector('.gotit-img');
    img.style.animation = 'none';
    img.offsetHeight;
    img.style.animation = '';
  } else {
    document.getElementById('feedback-correct').classList.add('hidden');
    document.getElementById('feedback-wrong').classList.remove('hidden');
    drawWrongFeedback(problem, userLines);
  }
}

function goNext() {
  document.getElementById('feedback-overlay').classList.add('hidden');
  const next = AppState.currentIndex + 1;
  if (next >= AppState.problems.length) showResult();
  else loadQuestion(next);
}

function showResult() {
  showScreen('screen-result');
  const score = AppState.score;
  const total = AppState.problems.length;
  document.getElementById('final-score').textContent = score;

  let msg = '';
  if      (score === total)        msg = 'ぜんぶせいかい！！ あなたはてんさい！🎉';
  else if (score >= total * 0.8)   msg = 'とてもよくできました！';
  else if (score >= total * 0.6)   msg = 'よくがんばりました！';
  else                              msg = 'がんばった！またあそぼう！！';
  document.getElementById('result-msg').textContent = msg;
}

async function startGame() {
  const level  = AppState.level;
  const apiKey = AppState.apiKey;

  if (apiKey) {
    showLoading(true);
    try {
      AppState.problems = await generateProblems(level, 5, apiKey);
    } catch (e) {
      console.warn('AI生成失敗:', e.message);
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

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      loadQuestion(0);
    });
  });
}

function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

/* ============================================================
   イベントバインド
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
      document.getElementById('btn-start').disabled = false;
    });
  });

  document.getElementById('btn-start').addEventListener('click', startGame);

  document.getElementById('btn-toggle-api').addEventListener('click', () => {
    document.getElementById('api-key-panel').classList.toggle('hidden');
  });

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

  const savedKey = loadApiKey();
  if (savedKey) {
    AppState.apiKey = savedKey;
    document.getElementById('input-api-key').value = savedKey;
  }

  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('ホームに戻りますか？（進捗は失われます）')) showScreen('screen-start');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    clearAnswerLines();
    const ov = document.getElementById('canvas-overlay');
    ov.style.pointerEvents = 'auto';
    ov.style.cursor = 'crosshair';
  });

  document.getElementById('btn-undo').addEventListener('click', () => {
    undoLastLine();
    const ov = document.getElementById('canvas-overlay');
    ov.style.pointerEvents = 'auto';
    ov.style.cursor = 'crosshair';
  });

  document.getElementById('btn-check').addEventListener('click', checkAnswer);
  document.getElementById('btn-next-wrong').addEventListener('click', goNext);
  document.getElementById('btn-next-correct').addEventListener('click', goNext);
  document.getElementById('btn-retry').addEventListener('click', startGame);
  document.getElementById('btn-result-home').addEventListener('click', () => {
    showScreen('screen-start');
  });

  const defaultLvBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultLvBtn) {
    defaultLvBtn.classList.add('selected');
    AppState.level = 1;
    document.getElementById('btn-start').disabled = false;
  }
});
