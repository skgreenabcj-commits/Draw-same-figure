/**
 * app.js  v2.2
 * メインアプリケーションロジック
 *
 * 【v2.2 変更点】
 * Bug修正: startGame() に Promise.race による全体タイムアウトガード（60秒）を追加。
 *   旧版では generateProblems() 内部の個別タイムアウトが機能しない状況
 *   （_fetchAvailableModels のフリーズ等）で showLoading(false) が永久に
 *   呼ばれず、「AIが問題を作っています…」スピナーが消えない問題があった。
 *   修正後は Promise.race により最大 60 秒でタイムアウトし、
 *   finally ブロックで確実にスピナーを非表示にする。
 *   ※ gemini.js v4.1 の _fetchAvailableModels タイムアウト修正と合わせて
 *   二重の安全網として機能する。
 *
 * 【v2.1 変更点（維持）】
 * Bug #3: judgeAnswer() が hintLines を線分オブジェクト配列として正しく処理。
 * Bug #4: updateHintMsg() の remain 計算が正しい本数を返す。
 * Bug #5: _refreshOverlayLimit() でオーバーレイ制御を一元管理。
 */

/* ============================================================
   アプリ状態オブジェクト
   ============================================================ */
/**
 * AppState: アプリ全体で共有するゲーム進行状態。
 *
 * level        : 選択されたレベル番号 (0–3)
 * problems     : 現在のゲームで使用する問題の配列（5問）
 * currentIndex : 現在表示中の問題インデックス (0–4)
 * score        : 現在の正解数
 * useAI        : AI生成問題を使用しているか
 * apiKey       : Gemini API キー（localStorage から復元）
 */
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
  'さすが！！ てんさい！',
  'せいかい！よくできました！',
  'かっこいい！',
  'おみごと！！ 🌟',
  'すばらしい！！'
];

/**
 * 褒め言葉をランダムに1つ返す。
 * @returns {string}
 */
function randomPraise() {
  return PRAISE_LIST[Math.floor(Math.random() * PRAISE_LIST.length)];
}

/* ============================================================
   画面切り替え
   ============================================================ */
/**
 * 指定した ID の画面を表示し、他の画面を非表示にする。
 * @param {string} id
 */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ============================================================
   正誤判定
   ============================================================ */
/**
 * ユーザーの回答が正解と一致するか判定する。
 *
 * 【Bug #3 修正後の動作】
 * problem.hintLines は {x1,y1,x2,y2} 形式のオブジェクト配列であるため
 * normalize() が正しく文字列キーを生成できる。
 *
 * 判定ロジック:
 *   1. ヒント線＋ユーザー線の合計本数が正解本数と一致するか確認
 *   2. 全線分を正規化（始点・終点の順序を統一して文字列キー化）
 *   3. ユーザーの全線分が正解セットに含まれるか確認
 *   4. 重複線がないか確認（Set のサイズで判定）
 *
 * @param {Object} problem
 * @param {Array}  userLines
 * @returns {boolean}
 */
function judgeAnswer(problem, userLines) {
  const correct      = problem.lines;
  const hint         = problem.hintLines || [];
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

/* ============================================================
   UI 更新
   ============================================================ */
/**
 * ヘッダーの進捗テキスト・プログレスバー・スコアを更新する。
 */
function updateProgress() {
  const total = AppState.problems.length;
  const cur   = AppState.currentIndex + 1;
  document.getElementById('progress-text').textContent = `${cur} / ${total}もん`;
  document.getElementById('progress-bar').style.width  = `${(cur / total) * 100}%`;
  document.getElementById('score-text').textContent    = `⭐ ${AppState.score}`;
}

/**
 * ヒントメッセージ「のこり〇ほんのせんをかこう！」を更新・表示する。
 *
 * 【Bug #4 修正後の動作】
 * hintLines が正しいオブジェクト配列になったため
 * remain = lines.length - hintLines.length が正しい残り本数を返す。
 *
 * @param {Object} problem
 */
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
   オーバーレイ制限の更新（Bug #5 修正: 新設ヘルパー）
   ============================================================ */
/**
 * 現在のユーザー線数に基づいてオーバーレイの入力可否を切り替える。
 *
 * 【Bug #5 修正内容】
 * loadQuestion / clear / undo / setupInteraction コールバックの
 * 4か所に散在していたオーバーレイ制御を、この関数に一元化した。
 * Lv0/Lv1: maxLines に達したら入力不可。
 * Lv2/Lv3: 常に入力可能。
 *
 * @param {Object} problem
 * @param {number} lineCount
 */
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
   問題ロード
   ============================================================ */
/**
 * 指定インデックスの問題を読み込んで画面を初期化する。
 *
 * 【Bug #5 修正箇所】
 * setupInteraction() の直後にあった無条件リセットブロックを削除し、
 * _refreshOverlayLimit(problem, 0) で初期状態を正しく設定する。
 *
 * @param {number} index
 */
function loadQuestion(index) {
  const problem = AppState.problems[index];
  AppState.currentIndex = index;

  updateProgress();
  initCanvases(problem);
  updateHintMsg(problem);
  buildGridHeaders(problem);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawModel(problem);
      drawAnswer(problem);

      setupInteraction(problem, (lineCount) => {
        _refreshOverlayLimit(problem, lineCount);
      });

      // 問題開始時（lineCount=0）の初期オーバーレイ状態を設定
      _refreshOverlayLimit(problem, 0);
    });
  });
}

/* ============================================================
   こたえあわせ
   ============================================================ */
/**
 * ユーザーの回答を判定し、正誤フィードバックオーバーレイを表示する。
 */
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

/* ============================================================
   次の問題 / 結果画面
   ============================================================ */
/**
 * フィードバックを閉じて次の問題に進む。全問終了で結果画面へ。
 */
function goNext() {
  document.getElementById('feedback-overlay').classList.add('hidden');
  const next = AppState.currentIndex + 1;
  if (next >= AppState.problems.length) {
    showResult();
  } else {
    loadQuestion(next);
  }
}

/**
 * 結果画面を表示し、スコアとメッセージを設定する。
 */
function showResult() {
  showScreen('screen-result');
  const score = AppState.score;
  const total = AppState.problems.length;
  document.getElementById('final-score').textContent = score;

  let msg = '';
  if      (score === total)      msg = 'ぜんぶせいかい！！ あなたはてんさい！🎉';
  else if (score >= total * 0.8) msg = 'とてもよくできました！';
  else if (score >= total * 0.6) msg = 'よくがんばりました！';
  else                           msg = 'がんばった！またあそぼう！！';
  document.getElementById('result-msg').textContent = msg;
}

/* ============================================================
   ゲーム開始
   ============================================================ */
/**
 * ゲームを開始する非同期関数。
 *
 * 【v2.2 変更点】
 * Promise.race による全体タイムアウトガード（60秒）を追加。
 *
 * タイムアウトの設計:
 *   - generateProblems() が内部でフリーズした場合でも、
 *     Promise.race により最大 60 秒で強制的に reject させる。
 *   - finally ブロックで showLoading(false) を確実に呼ぶため、
 *     タイムアウト時もスピナーが必ず消える。
 *   - タイムアウト後はフォールバック問題（getProblems）で継続する。
 *
 * 60 秒に設定した理由:
 *   resolveModel() の最悪ケース（全モデルを直列プローブ）で約 45 秒かかる
 *   ため、それに十分な余裕を持たせた値。ユーザー体験上は alert で案内する。
 */
async function startGame() {
  const level  = AppState.level;
  const apiKey = AppState.apiKey;

  if (apiKey) {
    showLoading(true);
    try {
      // ── 全体タイムアウトガード（60秒）────────────────────────────
      // generateProblems() が内部のいずれかのステップで無限待機した場合に
      // 強制的にタイムアウトさせる二重の安全網。
      // gemini.js v4.1 の _fetchAvailableModels タイムアウトと合わせて
      // 二層の防護として機能する。
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('問題生成がタイムアウトしました（60秒）。\n内蔵問題を使用します。')),
          60000
        )
      );

      AppState.problems = await Promise.race([
        generateProblems(level, 5, apiKey),
        timeoutPromise
      ]);

    } catch (e) {
      // タイムアウト・API エラー・認証エラーをすべてここで捕捉
      console.warn('AI生成失敗:', e.message);
      alert(`AI問題生成エラー:\n${e.message}\n\n内蔵問題を使用します。`);
      AppState.problems = getProblems(level);
    } finally {
      // 成功・失敗・タイムアウトのいずれの場合も必ずスピナーを消す
      showLoading(false);
    }
  } else {
    // API キーなし: 内蔵問題バンクから取得（同期）
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

/* ============================================================
   ローディング表示制御
   ============================================================ */
/**
 * ローディングオーバーレイの表示・非表示を切り替える。
 * @param {boolean} show
 */
function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

/* ============================================================
   イベントバインド
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  /* ---- スタート画面 ---- */

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

  /* ---- ゲーム画面 ---- */

  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('ホームに戻りますか？（進捗は失われます）')) {
      showScreen('screen-start');
    }
  });

  // 「ぜんぶけす」: 全線分消去 → オーバーレイ制限を lineCount=0 で再評価
  document.getElementById('btn-clear').addEventListener('click', () => {
    clearAnswerLines();
    const problem = AppState.problems[AppState.currentIndex];
    if (problem) _refreshOverlayLimit(problem, 0);
  });

  // 「１つもどす」: アンドゥ後の線数でオーバーレイ制限を再評価
  document.getElementById('btn-undo').addEventListener('click', () => {
    undoLastLine();
    const problem   = AppState.problems[AppState.currentIndex];
    const lineCount = getAnswerLines().length;
    if (problem) _refreshOverlayLimit(problem, lineCount);
  });

  document.getElementById('btn-check').addEventListener('click', checkAnswer);

  document.getElementById('btn-next-wrong').addEventListener('click', goNext);
  document.getElementById('btn-next-correct').addEventListener('click', goNext);

  /* ---- 結果画面 ---- */

  document.getElementById('btn-retry').addEventListener('click', startGame);

  document.getElementById('btn-result-home').addEventListener('click', () => {
    showScreen('screen-start');
  });

  /* ---- 初期選択状態 ---- */
  const defaultLvBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultLvBtn) {
    defaultLvBtn.classList.add('selected');
    AppState.level = 1;
    document.getElementById('btn-start').disabled = false;
  }
});
