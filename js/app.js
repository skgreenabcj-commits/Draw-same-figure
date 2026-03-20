/**
 * app.js  v2.1
 * メインアプリケーションロジック
 *
 * 【Bug #3 / #4 / #5 修正内容まとめ】
 *
 * Bug #3（連鎖修正）:
 *   problems.js の getProblems() が hintLines を線分オブジェクト配列で
 *   返すようになったため、judgeAnswer() の normalize(l) が l.x1 等を
 *   正しく参照できるようになった。
 *   旧版では hintLines が存在せず hint = [] となり、
 *   allUserLines に hint の内容が含まれなかったため
 *   allUserLines.length !== correct.length → 常に false を返していた。
 *
 * Bug #4（直接修正）:
 *   updateHintMsg() の remain 計算式は変えていない。
 *   Bug #3 の修正により hintLines が正しい本数の線分配列を持つため
 *   remain = problem.lines.length - hintLines.length が正しい値になる。
 *
 * Bug #5（直接修正）:
 *   _refreshOverlayLimit() ヘルパー関数を新設し、
 *   オーバーレイの pointerEvents 制御を一か所に集約した。
 *   旧版では「setupInteraction コールバック内で制限を設定した直後に
 *   loadQuestion の末尾コードが 'auto' に上書きしてしまう」問題があった。
 *   修正後は loadQuestion の末尾リセットを削除し、_refreshOverlayLimit()
 *   がコールバック・undo・clear から共通呼び出しされる設計にした。
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
/** 正解時にランダムに表示する褒め言葉の配列 */
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
 * 指定した ID の画面を表示状態にし、他の画面を非表示にする。
 * .screen 要素に .active クラスを付け外しすることで切り替える。
 *
 * @param {string} id - 表示する画面要素の ID
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
 * 旧版では hintLines = [] だったため allUserLines にヒント線が含まれず、
 * 本数チェック（allUserLines.length !== correct.length）で必ず false を
 * 返していた（Lv0/Lv1 で正解できない致命的バグ）。
 *
 * 判定ロジック:
 *   1. ヒント線＋ユーザー線の合計本数が正解本数と一致するか確認
 *   2. 全線分を正規化（始点・終点の順序を統一して文字列キー化）
 *   3. ユーザーの全線分が正解セットに含まれるか確認
 *   4. 重複線がないか確認（Set のサイズで判定）
 *
 * @param {Object} problem   - 現在の問題オブジェクト
 * @param {Array}  userLines - ユーザーが引いた線分の配列（ヒント線は含まない）
 * @returns {boolean} 正解なら true
 */
function judgeAnswer(problem, userLines) {
  const correct  = problem.lines;
  // hintLines は線分オブジェクトの配列（Bug #3 修正により正しく渡される）
  const hint     = problem.hintLines || [];
  // ヒント線とユーザー線を合算して「回答全体」とする
  const allUserLines = [...hint, ...userLines];

  // 本数チェック: 合計線数が正解と一致しなければ即座に不正解
  if (allUserLines.length !== correct.length) return false;

  /**
   * 線分を方向に依存しない文字列キーに正規化する。
   * (x1,y1)→(x2,y2) と (x2,y2)→(x1,y1) は同じ線分として扱う。
   * 2つの表現を文字列化して辞書順の小さい方を使用する。
   */
  const normalize = l => [
    `${l.x1},${l.y1}-${l.x2},${l.y2}`,
    `${l.x2},${l.y2}-${l.x1},${l.y1}`
  ].sort()[0];

  // 正解線分セットを構築
  const correctSet = new Set(correct.map(normalize));

  // ユーザーの全線分が正解セットに含まれるか確認
  for (const line of allUserLines) {
    if (!correctSet.has(normalize(line))) return false;
  }

  // 重複線のチェック: Set サイズ = 正解本数 なら重複なし
  const userSet = new Set(allUserLines.map(normalize));
  return userSet.size === correctSet.size;
}

/* ============================================================
   UI 更新
   ============================================================ */
/**
 * ヘッダーの進捗テキスト・プログレスバー・スコアを更新する。
 * 問題ロード時と正解時に呼ばれる。
 */
function updateProgress() {
  const total = AppState.problems.length;
  const cur   = AppState.currentIndex + 1;
  document.getElementById('progress-text').textContent = `${cur} / ${total}もん`;
  // プログレスバーの幅を進捗率（%）で設定
  document.getElementById('progress-bar').style.width  = `${(cur / total) * 100}%`;
  document.getElementById('score-text').textContent    = `⭐ ${AppState.score}`;
}

/**
 * ヒントメッセージ「のこり〇ほんのせんをかこう！」を更新・表示する。
 *
 * 【Bug #4 修正後の動作】
 * problem.hintLines が正しい本数のオブジェクト配列になったため
 * remain = lines.length - hintLines.length が正しい残り本数を返す。
 * 旧版では hintLines = [] だったため remain = 4 になっていた
 * （Lv0 なら「のこり4ほん」と誤表示されていた）。
 *
 * @param {Object} problem - 現在の問題オブジェクト
 */
function updateHintMsg(problem) {
  const hintEl = document.getElementById('hint-msg');

  // Lv0 と Lv1 のみヒントメッセージを表示する
  if (problem.level !== 0 && problem.level !== 1) {
    hintEl.classList.add('hidden');
    return;
  }

  // 残り本数 = 全線数 - ヒント本数（Bug #4 修正後: hintLines.length が正しい値）
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
 * 旧版では setupInteraction のコールバック内でオーバーレイを 'none' に
 * 設定しても、loadQuestion 末尾の2行が即座に 'auto' に上書きしていた。
 * さらに同じ3行コードが clear / undo / setupInteraction / loadQuestion の
 * 4か所に散在していた（DRY 原則違反）。
 *
 * 修正後の設計:
 *   - この関数を唯一の制御ポイントとする
 *   - Lv0/Lv1: maxLines に達したら入力を不可にする
 *   - Lv2/Lv3 および lines=0 の場合は常に入力可能
 *   - clear / undo の後は再評価するため同じ関数を呼ぶ
 *
 * @param {Object} problem   - 現在の問題オブジェクト
 * @param {number} lineCount - ユーザーが現在引いている線数
 */
function _refreshOverlayLimit(problem, lineCount) {
  const ov = document.getElementById('canvas-overlay');
  if (!ov) return;

  // Lv2/Lv3 はヒントなし・制限なし → 常に入力可能
  if (problem.level !== 0 && problem.level !== 1) {
    ov.style.pointerEvents = 'auto';
    ov.style.cursor        = 'crosshair';
    return;
  }

  // Lv0/Lv1: 残り本数 = 全線数 - ヒント本数
  const maxLines = problem.lines.length - (problem.hintLines || []).length;

  if (lineCount >= maxLines) {
    // 上限に達した: これ以上引けないようにオーバーレイを無効化
    ov.style.pointerEvents = 'none';
    ov.style.cursor        = 'not-allowed';
  } else {
    // まだ引ける: オーバーレイを有効化
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
 * 旧版では setupInteraction() の直後に以下のコードがあり、
 * コールバック内で設定した pointerEvents を即座に上書きしていた:
 *   const ov = document.getElementById('canvas-overlay');
 *   ov.style.pointerEvents = 'auto';   ← 無条件リセット
 *   ov.style.cursor = 'crosshair';
 *
 * 修正後: このリセットブロックを削除し、_refreshOverlayLimit() を
 * 問題開始時（lineCount=0）で呼ぶことで初期状態を正しく設定する。
 * （Lv0/Lv1 は maxLines > 0 なので初期は 'auto' になる）
 *
 * @param {number} index - 読み込む問題のインデックス
 */
function loadQuestion(index) {
  const problem = AppState.problems[index];
  AppState.currentIndex = index;

  // 進捗表示・ヒントメッセージ・ヘッダーを更新
  updateProgress();
  initCanvases(problem);   // canvas.js: ユーザー線リセット
  updateHintMsg(problem);  // Bug #4 修正後は正しい残り本数が表示される
  buildGridHeaders(problem);

  // DOM 更新が完了してからキャンバスを描画する（2フレーム待機）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawModel(problem);
      drawAnswer(problem);

      // タッチ/マウス操作を設定
      // onLineAdded コールバックで線数上限の管理を行う
      setupInteraction(problem, (lineCount) => {
        // 【Bug #5 修正】_refreshOverlayLimit に委譲
        _refreshOverlayLimit(problem, lineCount);
      });

      // 【Bug #5 修正】問題開始時（lineCount=0）の初期状態を設定
      // 旧版: ここに無条件リセットコードがあり Bug #5 を引き起こしていた
      // 修正後: lineCount=0 として _refreshOverlayLimit を呼ぶ
      // → Lv0/Lv1 は maxLines>0 なので 'auto' になる（正しい初期状態）
      _refreshOverlayLimit(problem, 0);
    });
  });
}

/* ============================================================
   こたえあわせ
   ============================================================ */
/**
 * ユーザーの回答を判定し、正誤フィードバックオーバーレイを表示する。
 * 正解時はスコアを加算し褒め言葉を表示する。
 * 不正解時は正解との差分を canvas-wrong に描画する。
 */
function checkAnswer() {
  const problem   = AppState.problems[AppState.currentIndex];
  const userLines = getAnswerLines(); // canvas.js から現在の線分を取得
  const isCorrect = judgeAnswer(problem, userLines);

  // フィードバックオーバーレイを表示
  document.getElementById('feedback-overlay').classList.remove('hidden');

  if (isCorrect) {
    // ── 正解 ──────────────────────────────────────────────────────
    AppState.score++;
    document.getElementById('score-text').textContent = `⭐ ${AppState.score}`;
    document.getElementById('feedback-wrong').classList.add('hidden');
    document.getElementById('feedback-correct').classList.remove('hidden');
    document.getElementById('praise-text').textContent = randomPraise();

    // gotit.png のアニメーションをリセットして再生する
    // （animation プロパティを一度 none にして強制リフロー後に再設定）
    const img = document.querySelector('.gotit-img');
    img.style.animation = 'none';
    img.offsetHeight;    // 強制リフロー（void キャストの代替）
    img.style.animation = '';
  } else {
    // ── 不正解 ────────────────────────────────────────────────────
    document.getElementById('feedback-correct').classList.add('hidden');
    document.getElementById('feedback-wrong').classList.remove('hidden');
    // 正解と誤答の差分を小さなキャンバスに描画
    drawWrongFeedback(problem, userLines);
  }
}

/* ============================================================
   次の問題 / 結果画面
   ============================================================ */
/**
 * フィードバックを閉じて次の問題に進む。
 * 全問終了していれば結果画面を表示する。
 */
function goNext() {
  document.getElementById('feedback-overlay').classList.add('hidden');
  const next = AppState.currentIndex + 1;
  if (next >= AppState.problems.length) {
    showResult(); // 全問終了 → 結果画面へ
  } else {
    loadQuestion(next); // 次の問題へ
  }
}

/**
 * 結果画面を表示し、スコアとメッセージを設定する。
 * スコアに応じて4段階のメッセージを選択する。
 */
function showResult() {
  showScreen('screen-result');
  const score = AppState.score;
  const total = AppState.problems.length;
  document.getElementById('final-score').textContent = score;

  // スコア率に応じてメッセージを選択
  let msg = '';
  if      (score === total)           msg = 'ぜんぶせいかい！！ あなたはてんさい！🎉';
  else if (score >= total * 0.8)      msg = 'とてもよくできました！';
  else if (score >= total * 0.6)      msg = 'よくがんばりました！';
  else                                msg = 'がんばった！またあそぼう！！';
  document.getElementById('result-msg').textContent = msg;
}

/* ============================================================
   ゲーム開始
   ============================================================ */
/**
 * ゲームを開始する非同期関数。
 *
 * APIキーが設定されている場合は Gemini API で問題を生成する。
 * 生成に失敗した場合は alert を出して内蔵問題バンクを使用する。
 * APIキーが未設定の場合は即座に内蔵問題バンク（getProblems）を使用する。
 *
 * 問題取得後: スコアをリセットしてゲーム画面に遷移する。
 */
async function startGame() {
  const level  = AppState.level;
  const apiKey = AppState.apiKey;

  if (apiKey) {
    // API キーあり: Gemini で問題を生成
    showLoading(true);
    try {
      AppState.problems = await generateProblems(level, 5, apiKey);
    } catch (e) {
      console.warn('AI生成失敗:', e.message);
      alert(`AI問題生成エラー:\n${e.message}\n\n内蔵問題を使用します。`);
      AppState.problems = getProblems(level); // フォールバック
    } finally {
      showLoading(false); // 成功・失敗どちらの場合もローディングを消す
    }
  } else {
    // API キーなし: 内蔵問題バンクから取得（同期）
    AppState.problems = getProblems(level);
  }

  // スコアと問題インデックスをリセット
  AppState.score        = 0;
  AppState.currentIndex = 0;

  // ゲーム画面に切り替え
  showScreen('screen-game');

  // DOM 更新を待ってから最初の問題をロード
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
 * Gemini API 呼び出し中に表示してユーザーを待機させる。
 *
 * @param {boolean} show - true で表示、false で非表示
 */
function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

/* ============================================================
   イベントバインド
   ============================================================ */
/**
 * DOMContentLoaded 後にすべての UI イベントリスナーを登録する。
 * ページロード時に一度だけ実行される。
 */
document.addEventListener('DOMContentLoaded', () => {

  /* ---- スタート画面のイベント ---- */

  // レベル選択ボタン: クリックで選択状態を切り替え「はじめる！」を有効化
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // 既存の選択状態をすべて解除
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      AppState.level = parseInt(btn.dataset.level, 10);
      document.getElementById('btn-start').disabled = false;
    });
  });

  // 「はじめる！」ボタン
  document.getElementById('btn-start').addEventListener('click', startGame);

  // API キーパネルの開閉トグル
  document.getElementById('btn-toggle-api').addEventListener('click', () => {
    document.getElementById('api-key-panel').classList.toggle('hidden');
  });

  // API キーの保存・クリア
  document.getElementById('btn-save-api').addEventListener('click', () => {
    const key = document.getElementById('input-api-key').value.trim();
    if (key) {
      saveApiKey(key);           // gemini.js: localStorage に保存＆モデルキャッシュクリア
      AppState.apiKey = key;
      alert('APIキーを保存しました。次回からAI問題生成が有効になります。');
    } else {
      saveApiKey('');
      AppState.apiKey = '';
      alert('APIキーをクリアしました。');
    }
  });

  // 保存済み API キーを復元して入力欄に表示
  const savedKey = loadApiKey(); // gemini.js: localStorage から読み込み
  if (savedKey) {
    AppState.apiKey = savedKey;
    document.getElementById('input-api-key').value = savedKey;
  }

  /* ---- ゲーム画面のイベント ---- */

  // ホームボタン: 確認ダイアログ後にスタート画面へ戻る
  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('ホームに戻りますか？（進捗は失われます）')) {
      showScreen('screen-start');
    }
  });

  // 「ぜんぶけす」ボタン: 全線分を消去してオーバーレイ制限を再評価
  document.getElementById('btn-clear').addEventListener('click', () => {
    clearAnswerLines(); // canvas.js: 全ユーザー線を削除して再描画
    // 【Bug #5 修正】_refreshOverlayLimit に委譲（lineCount=0 で必ず 'auto' になる）
    const problem = AppState.problems[AppState.currentIndex];
    if (problem) _refreshOverlayLimit(problem, 0);
  });

  // 「１つもどす」ボタン: 最後の線分を取り消してオーバーレイ制限を再評価
  document.getElementById('btn-undo').addEventListener('click', () => {
    undoLastLine(); // canvas.js: 最後の線分を削除して再描画
    // アンドゥ後の線数で制限を再評価
    // 【Bug #5 修正】canvas.js から現在の線数を取得して _refreshOverlayLimit を呼ぶ
    const problem   = AppState.problems[AppState.currentIndex];
    const lineCount = getAnswerLines().length; // アンドゥ後の線数
    if (problem) _refreshOverlayLimit(problem, lineCount);
  });

  // 「こたえあわせ」ボタン
  document.getElementById('btn-check').addEventListener('click', checkAnswer);

  // フィードバック画面の「つぎへ」ボタン（不正解・正解の両方）
  document.getElementById('btn-next-wrong').addEventListener('click', goNext);
  document.getElementById('btn-next-correct').addEventListener('click', goNext);

  /* ---- 結果画面のイベント ---- */

  // 「もういちど」ボタン: 同じレベルで再スタート
  document.getElementById('btn-retry').addEventListener('click', startGame);

  // 「ホームへ」ボタン: スタート画面へ戻る
  document.getElementById('btn-result-home').addEventListener('click', () => {
    showScreen('screen-start');
  });

  /* ---- 初期選択状態の設定 ---- */
  // ページロード時は Lv1 をデフォルト選択状態にして「はじめる！」を有効化
  const defaultLvBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultLvBtn) {
    defaultLvBtn.classList.add('selected');
    AppState.level = 1;
    document.getElementById('btn-start').disabled = false;
  }
});
