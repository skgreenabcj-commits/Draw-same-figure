/**
 * app.js  v2.3
 * メインアプリケーションロジック
 *
 * 【v2.3 変更点】
 * 管理者AIモデル設定機能を追加（gemini.js v5.6 連携）:
 *   - geminiStatusUpdate イベントを監視し、エラー通知バナーを表示
 *   - エラー5回以上・廃止モデル検出時に管理者設定パネルを自動表示
 *   - /v1beta/models からflash系モデル一覧を取得して選択UIを提供
 *   - flash-liteをシステム推奨として表示
 *   - 選択モデルをADMIN_CHAIN_KEYに保存してFALLBACK_CHAINを上書き
 *   - 全体タイムアウトを 60秒→30秒 に短縮（gemini.js v5.6 の8秒×2回×3モデル に合わせた）
 *
 * 【v2.2 変更点（維持）】
 *   Promise.race による全体タイムアウトガード
 *
 * 【v2.1 変更点（維持）】
 *   Bug #3: judgeAnswer() hintLines の正しい処理
 *   Bug #4: updateHintMsg() remain 計算修正
 *   Bug #5: _refreshOverlayLimit() オーバーレイ制御一元化
 */

/* ============================================================
   アプリ状態オブジェクト
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
  'さすが！！ てんさい！',
  'せいかい！よくできました！',
  'かっこいい！',
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
function updateProgress() {
  const total = AppState.problems.length;
  const cur   = AppState.currentIndex + 1;
  document.getElementById('progress-text').textContent = `${cur} / ${total}もん`;
  document.getElementById('progress-bar').style.width  = `${(cur / total) * 100}%`;
  document.getElementById('score-text').textContent    = `⭐ ${AppState.score}`;
}

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
   オーバーレイ制限
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
   問題ロード
   ============================================================ */
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
      _refreshOverlayLimit(problem, 0);
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
  if      (score === total)      msg = 'ぜんぶせいかい！！ あなたはてんさい！🎉';
  else if (score >= total * 0.8) msg = 'とてもよくできました！';
  else if (score >= total * 0.6) msg = 'よくがんばりました！';
  else                           msg = 'がんばった！またあそぼう！！';
  document.getElementById('result-msg').textContent = msg;
}

/* ============================================================
   ゲーム開始
   ============================================================ */
async function startGame() {
  const level  = AppState.level;
  const apiKey = AppState.apiKey;

  if (apiKey) {
    showLoading(true);
    try {
      // 全体タイムアウト: gemini.js v5.6 の最悪ケース(8s×2回×3モデル=48s)に余裕を持たせ30秒
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('問題生成がタイムアウトしました。\n内蔵問題を使用します。')),
          30000
        )
      );
      AppState.problems = await Promise.race([
        generateProblems(level, 5, apiKey),
        timeoutPromise
      ]);
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
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { loadQuestion(0); });
  });
}

/* ============================================================
   ローディング表示
   ============================================================ */
function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

/* ============================================================
   管理者モデル設定パネル（v2.3 追加）
   ============================================================ */

/**
 * エラーバナーを表示する。
 * @param {string} message - 表示メッセージ
 * @param {'error'|'info'} type - バナー種別（色が変わる）
 */
function showErrorBanner(message, type = 'error') {
  const banner = document.getElementById('model-error-banner');
  if (!banner) return;
  banner.textContent = type === 'error'
    ? `⚠️ AI: ${message}　（クリックしてモデル設定）`
    : `💡 ${message}　（クリックしてモデル設定）`;
  banner.className = `model-error-banner model-error-banner--${type}`;
  // hidden クラスを除去して表示
  banner.classList.remove('hidden');
}

function hideErrorBanner() {
  const banner = document.getElementById('model-error-banner');
  if (banner) banner.classList.add('hidden');
}

/**
 * 管理者モデル設定パネルを開き、ライブモデル一覧を表示する。
 */
async function openAdminModelPanel() {
  const panel = document.getElementById('admin-model-panel');
  if (!panel) return;

  const listEl = document.getElementById('admin-model-list');
  listEl.innerHTML = '<p class="admin-loading">モデル一覧を取得中...</p>';
  panel.classList.remove('hidden');

  const apiKey = AppState.apiKey;
  if (!apiKey) {
    listEl.innerHTML = '<p class="admin-error">APIキーが設定されていません。<br>先にAPIキーを保存してください。</p>';
    return;
  }

  // ライブモデルキャッシュをクリアして最新を取得
  try { localStorage.removeItem('gemini_live_models_v1'); } catch(_) {}
  const liveModels = await fetchLiveModels(apiKey);

  if (!liveModels || liveModels.length === 0) {
    listEl.innerHTML = '<p class="admin-error">モデル一覧の取得に失敗しました。<br>ネットワーク接続を確認してください。</p>';
    return;
  }

  // 現在の管理者チェーンを取得
  const currentChain = loadAdminChain() || [];

  listEl.innerHTML = '';

  // 推奨案内ノート（flash-lite がある場合のみ表示）
  const hasLite = liveModels.some(m => m.includes('flash-lite'));
  if (hasLite) {
    const note = document.createElement('p');
    note.className = 'admin-model-note';
    note.textContent = '💡 flash-lite を含むモデルが推奨です（高速・無償枠対応）';
    listEl.appendChild(note);
  }

  // 現在の実行チェーン情報（window._geminiStatus から取得）
  const currentStatus = window._geminiStatus || {};
  const activeChain   = currentStatus.currentChain || currentChain;

  // モデル一覧を描画
  liveModels.forEach(model => {
    const isLite    = model.includes('flash-lite');
    const chainIdx  = currentChain.indexOf(model);
    const activeIdx = activeChain.indexOf(model);

    const item = document.createElement('label');
    item.className = 'admin-model-item' + (chainIdx >= 0 ? ' admin-model-item--selected' : '');

    const checkbox = document.createElement('input');
    checkbox.type    = 'checkbox';
    checkbox.value   = model;
    checkbox.checked = chainIdx >= 0;
    // チェック変更時に選択状態のクラスを更新
    checkbox.addEventListener('change', () => {
      item.classList.toggle('admin-model-item--selected', checkbox.checked);
    });

    const nameSpan = document.createElement('span');
    nameSpan.className   = 'admin-model-name';
    nameSpan.textContent = model;

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'admin-model-badges';
    if (isLite) {
      badgeSpan.innerHTML += '<span class="badge badge--recommend">★ 推奨</span>';
    }
    if (chainIdx >= 0) {
      badgeSpan.innerHTML += `<span class="badge badge--order">設定済み 優先${chainIdx + 1}位</span>`;
    }
    if (activeIdx >= 0 && activeIdx !== chainIdx) {
      badgeSpan.innerHTML += `<span class="badge badge--active">現在 優先${activeIdx + 1}位</span>`;
    }

    item.appendChild(checkbox);
    item.appendChild(nameSpan);
    item.appendChild(badgeSpan);
    listEl.appendChild(item);
  });
}

/**
 * 管理者設定を保存してパネルを閉じる。
 * チェックされた順（DOM順）を優先順位とする。
 */
function saveAdminModelSettings() {
  const checkboxes = document.querySelectorAll('#admin-model-list input[type="checkbox"]:checked');
  const chain = Array.from(checkboxes).map(cb => cb.value);

  if (chain.length === 0) {
    alert('少なくとも1つのモデルを選択してください。');
    return;
  }

  saveAdminChain(chain);
  clearModelCache();

  // Redo フラグをリセット
  if (window._geminiStatus) {
    window._geminiStatus.needsAdminRedo = false;
    window._geminiStatus.errorCount     = 0;
  }

  hideErrorBanner();
  document.getElementById('admin-model-panel').classList.add('hidden');
  alert(`モデル設定を保存しました。\n優先順位: ${chain.join(' → ')}`);
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
      // APIキー新規保存時はモデルキャッシュをクリア
      clearModelCache();
      alert('APIキーを保存しました。次回からAI問題生成が有効になります。');
      // 管理者設定未設定なら案内バナーを表示
      if (!loadAdminChain()) {
        showErrorBanner('AIモデルが未設定です。モデル設定から推奨モデルを選んでください。', 'info');
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

  /* ---- ゲーム画面 ---- */
  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('ホームに戻りますか？（進捗は失われます）')) {
      showScreen('screen-start');
    }
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
  document.getElementById('btn-next-wrong').addEventListener('click', goNext);
  document.getElementById('btn-next-correct').addEventListener('click', goNext);

  /* ---- 結果画面 ---- */
  document.getElementById('btn-retry').addEventListener('click', startGame);
  document.getElementById('btn-result-home').addEventListener('click', () => {
    showScreen('screen-start');
  });

  /* ---- 管理者モデル設定パネル ---- */
  document.getElementById('btn-admin-model')
    ?.addEventListener('click', openAdminModelPanel);

  document.getElementById('btn-admin-model-save')
    ?.addEventListener('click', saveAdminModelSettings);

  document.getElementById('btn-admin-model-close')
    ?.addEventListener('click', () => {
      document.getElementById('admin-model-panel').classList.add('hidden');
    });

  // バナークリックでパネルを開く
  document.getElementById('model-error-banner')
    ?.addEventListener('click', openAdminModelPanel);

  /* ---- geminiStatusUpdate イベント監視 ---- */
  window.addEventListener('geminiStatusUpdate', (e) => {
    const status = e.detail;
    if (!status) return;

    // エラーバナー更新
    if (status.lastError) {
      showErrorBanner(status.lastError, 'error');
    }

    // 廃止モデル検出または累計エラー閾値超過 → パネル自動表示
    if (status.needsAdminRedo) {
      openAdminModelPanel();
    }
  });

  /* ---- 初回起動時の案内 ---- */
  const defaultLvBtn = document.querySelector('.level-btn[data-level="1"]');
  if (defaultLvBtn) {
    defaultLvBtn.classList.add('selected');
    AppState.level = 1;
    document.getElementById('btn-start').disabled = false;
  }

  // APIキー設定済み・管理者チェーン未設定の場合は案内バナーを表示
  if (AppState.apiKey && !loadAdminChain()) {
    setTimeout(() => {
      showErrorBanner('AIモデルが未設定です。モデル設定から推奨モデルを選んでください。', 'info');
    }, 600);
  }
});
