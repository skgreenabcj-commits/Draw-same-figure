/**
 * admin.js  v1.0
 * 管理者設定画面（admin.html）専用ロジック
 *
 * 依存: gemini.js（saveApiKey, loadApiKey, fetchLiveModels,
 *                  saveAdminChain, loadAdminChain, clearAdminChain,
 *                  clearModelCache）
 */

/* ========================================================
   ログストレージ
   ======================================================== */
const ADMIN_LOG_KEY     = 'admin_log_v1';
const ADMIN_LOG_MAX     = 50; // 最大保持件数

function _loadLog() {
  try { return JSON.parse(localStorage.getItem(ADMIN_LOG_KEY) || '[]'); } catch(_) { return []; }
}
function _saveLog(entries) {
  try { localStorage.setItem(ADMIN_LOG_KEY, JSON.stringify(entries.slice(-ADMIN_LOG_MAX))); } catch(_) {}
}
function _appendLog(level, message) {
  const entries = _loadLog();
  entries.push({ ts: Date.now(), level, message });
  _saveLog(entries);
}

/* ========================================================
   ユーティリティ
   ======================================================== */
function _fmt(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function _setStatus(elId, msg, type = 'info') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className   = `admin-status-msg admin-status-msg--${type}`;
  el.style.display = msg ? 'block' : 'none';
}

function _isLite(name) { return name.includes('flash-lite'); }

/* ========================================================
   §1. APIキーセクション
   ======================================================== */
function initApiKeySection() {
  const inputEl   = document.getElementById('input-admin-apikey');
  const eyeBtn    = document.getElementById('btn-admin-apikey-show');
  const eyeIcon   = document.getElementById('apikey-eye-icon');
  const saveBtn   = document.getElementById('btn-admin-apikey-save');

  // 保存済みキーをロード
  const saved = loadApiKey();
  if (saved) { inputEl.value = saved; _setStatus('apikey-status', '✅ APIキーが設定されています', 'ok'); }

  // 表示/非表示トグル
  eyeBtn.addEventListener('click', () => {
    const isPassword = inputEl.type === 'password';
    inputEl.type     = isPassword ? 'text' : 'password';
    eyeIcon.className = isPassword ? 'fa fa-eye-slash' : 'fa fa-eye';
  });

  // 保存
  saveBtn.addEventListener('click', () => {
    const key = inputEl.value.trim();
    if (key) {
      saveApiKey(key);
      clearModelCache();
      _setStatus('apikey-status', '✅ APIキーを保存しました', 'ok');
      _appendLog('info', 'APIキーを更新しました');
      // モデル一覧が既に表示済みなら再取得
      if (!document.getElementById('select-model-1').disabled) fetchAndPopulateModels(key);
    } else {
      saveApiKey('');
      clearModelCache();
      _setStatus('apikey-status', '⚠️ APIキーをクリアしました', 'warn');
      _appendLog('warn', 'APIキーをクリアしました');
    }
  });
}

/* ========================================================
   §2. モデル優先順位セクション
   ======================================================== */
let _liveModels = []; // 取得したライブモデル一覧をキャッシュ

/**
 * ライブモデルを取得してプルダウンを構築する。
 */
async function fetchAndPopulateModels(apiKey) {
  _setStatus('models-fetch-status', '🔄 モデル一覧を取得中...', 'info');
  // キャッシュをクリアして最新を取得
  try { localStorage.removeItem('gemini_live_models_v1'); } catch(_) {}

  const models = await fetchLiveModels(apiKey);
  if (!models || models.length === 0) {
    _setStatus('models-fetch-status', '❌ モデル一覧の取得に失敗しました。ネットワークとAPIキーを確認してください。', 'error');
    _appendLog('error', 'ライブモデル取得失敗');
    return;
  }

  _liveModels = models;
  _setStatus('models-fetch-status', `✅ ${models.length}件のモデルを取得しました`, 'ok');
  _appendLog('info', `ライブモデル取得成功: ${models.join(', ')}`);

  // 現在の管理者チェーン
  const current = loadAdminChain() || [];

  // プルダウンを構築 (1〜3)
  [1, 2, 3].forEach(priority => {
    const sel = document.getElementById(`select-model-${priority}`);
    sel.innerHTML = '';

    // 「なし」オプション（第1優先以外のみ）
    if (priority > 1) {
      const noneOpt = document.createElement('option');
      noneOpt.value       = '';
      noneOpt.textContent = '— なし —';
      sel.appendChild(noneOpt);
    }

    // モデルオプション
    models.forEach(m => {
      const opt       = document.createElement('option');
      opt.value       = m;
      opt.textContent = _isLite(m) ? `${m}　★推奨` : m;
      sel.appendChild(opt);
    });

    sel.disabled = false;

    // 保存済みチェーンの値を反映
    if (current[priority - 1]) {
      sel.value = current[priority - 1];
    } else if (priority === 1) {
      // デフォルト: flash-lite があれば優先
      const lite = models.find(m => _isLite(m));
      sel.value = lite || models[0] || '';
    }

    _updatePriorityNote(priority);
    sel.addEventListener('change', () => _updatePriorityNote(priority));
  });

  document.getElementById('btn-save-chain').disabled = false;
  _renderCurrentChain();
}

/**
 * プルダウン横の推奨ノートを更新する。
 */
function _updatePriorityNote(priority) {
  const sel  = document.getElementById(`select-model-${priority}`);
  const note = document.getElementById(`note-model-${priority}`);
  if (!sel || !note) return;
  note.textContent = _isLite(sel.value) ? '★ 推奨モデルです' : '';
  note.className   = _isLite(sel.value) ? 'priority-note priority-note--recommend' : 'priority-note';
}

/**
 * 「現在の有効チェーン」バッジを表示する。
 */
function _renderCurrentChain() {
  const chain = loadAdminChain();
  const box   = document.getElementById('current-chain-display');
  const badges = document.getElementById('current-chain-badges');
  if (!chain || chain.length === 0) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  badges.innerHTML  = chain.map((m, i) =>
    `<span class="chain-badge chain-badge--${i+1}">${i+1}位: ${m}</span>`
  ).join('');
}

/**
 * 優先順位を保存する。
 */
function saveChain() {
  const sel1 = document.getElementById('select-model-1').value;
  const sel2 = document.getElementById('select-model-2').value;
  const sel3 = document.getElementById('select-model-3').value;

  if (!sel1) { _setStatus('chain-save-status', '⚠️ 第1優先モデルを選択してください', 'warn'); return; }

  // 重複チェック
  const chosen = [sel1, sel2, sel3].filter(Boolean);
  const unique  = [...new Set(chosen)];
  if (unique.length < chosen.length) {
    _setStatus('chain-save-status', '⚠️ 同じモデルを複数の優先順位に設定することはできません', 'warn');
    return;
  }

  saveAdminChain(unique);
  clearModelCache();
  _setStatus('chain-save-status', `✅ 保存しました: ${unique.join(' → ')}`, 'ok');
  _appendLog('info', `管理者チェーン保存: ${unique.join(' → ')}`);
  _renderCurrentChain();
}

function initModelSection() {
  document.getElementById('btn-fetch-models').addEventListener('click', () => {
    const apiKey = loadApiKey();
    if (!apiKey) {
      _setStatus('models-fetch-status', '⚠️ 先にAPIキーを保存してください', 'warn');
      return;
    }
    fetchAndPopulateModels(apiKey);
  });

  document.getElementById('btn-save-chain').addEventListener('click', saveChain);

  document.getElementById('btn-clear-chain').addEventListener('click', () => {
    if (!confirm('モデル優先設定をリセットします。よろしいですか？')) return;
    clearAdminChain();
    clearModelCache();
    _setStatus('chain-save-status', '🗑️ 設定をリセットしました。デフォルトチェーンが使用されます。', 'info');
    _appendLog('warn', '管理者チェーンをリセットしました');
    _renderCurrentChain();
    // プルダウンを無効化
    [1,2,3].forEach(p => {
      const sel = document.getElementById(`select-model-${p}`);
      sel.innerHTML = `<option value="">— モデルを取得してください —</option>`;
      sel.disabled  = true;
    });
    document.getElementById('btn-save-chain').disabled = true;
  });

  // 初期表示
  _renderCurrentChain();

  // APIキー設定済みなら自動取得
  const apiKey = loadApiKey();
  if (apiKey) fetchAndPopulateModels(apiKey);
}

/* ========================================================
   §3. ログ・ステータスセクション
   ======================================================== */
function _getRecommendedAction(lastError) {
  if (!lastError) return '';
  if (lastError.includes('廃止') || lastError.includes('404') || lastError.includes('410'))
    return '👉 推奨アクション: 「AIモデル優先順位」セクションで利用可能なモデルに更新してください。';
  if (lastError.includes('APIキーが無効') || lastError.includes('401') || lastError.includes('403'))
    return '👉 推奨アクション: 「Gemini APIキー設定」セクションでAPIキーを確認・再設定してください。';
  if (lastError.includes('タイムアウト') || lastError.includes('408'))
    return '👉 推奨アクション: ネットワーク環境を確認するか、高速なモデル（flash-lite）を第1優先に設定してください。';
  if (lastError.includes('レート制限') || lastError.includes('429'))
    return '👉 推奨アクション: しばらく時間をおいてから再試行してください。';
  if (lastError.includes('エラーが'))
    return '👉 推奨アクション: モデル設定を確認し、利用可能なモデルに更新してください。';
  return '👉 推奨アクション: ゲーム画面を再読み込みして再試行してください。';
}

function refreshStatus() {
  // window._geminiStatus は index.html（ゲーム画面）のコンテキストにあるため、
  // admin.html ではローカルストレージのキャッシュから情報を取得する。
  const status = _loadAdminStatus();

  // カード更新
  document.getElementById('val-error-count').textContent =
    status.errorCount !== undefined ? String(status.errorCount) : '—';
  document.getElementById('val-last-model').textContent =
    status.lastSuccessModel || '—';
  document.getElementById('val-needs-redo').textContent =
    status.needsAdminRedo ? '⚠️ 更新が必要' : (status.errorCount > 0 ? '確認推奨' : '✅ 問題なし');

  // 最後のエラー
  const errorBox = document.getElementById('last-error-box');
  if (status.lastError) {
    errorBox.style.display = 'block';
    document.getElementById('last-error-msg').textContent = status.lastError;
    document.getElementById('last-error-action').textContent = _getRecommendedAction(status.lastError);
  } else {
    errorBox.style.display = 'none';
  }

  // ログ一覧
  renderLog();
}

/**
 * ローカルストレージからゲーム側が書き込むステータスを読む。
 * gemini.js の _updateStatus は window._geminiStatus に書くが
 * admin.html は別ページのため、gemini.js が localStorage にも
 * 書き込む仕組みが必要。以下は既存の MODEL_CACHE_KEY などを利用。
 */
function _loadAdminStatus() {
  const base = { errorCount: 0, lastError: '', needsAdminRedo: false, lastSuccessModel: '' };
  try {
    const raw = localStorage.getItem('gemini_admin_status_v1');
    if (raw) return { ...base, ...JSON.parse(raw) };
  } catch(_) {}
  // MODEL_CACHE_KEY から直近の成功モデルを補完
  try {
    const mc = JSON.parse(localStorage.getItem('gemini_model_v3') || '{}');
    if (mc.model) base.lastSuccessModel = mc.model;
  } catch(_) {}
  return base;
}

function renderLog() {
  const entries = _loadLog();
  const listEl  = document.getElementById('admin-log-list');
  if (entries.length === 0) {
    listEl.innerHTML = '<p class="admin-log-empty">ログはまだありません。<br>ゲームでAI生成を行うとここに記録されます。</p>';
    return;
  }
  listEl.innerHTML = [...entries].reverse().map(e =>
    `<div class="admin-log-entry admin-log-entry--${e.level}">
       <span class="admin-log-ts">${_fmt(e.ts)}</span>
       <span class="admin-log-level admin-log-level--${e.level}">${e.level.toUpperCase()}</span>
       <span class="admin-log-msg">${e.message}</span>
     </div>`
  ).join('');
}

function initLogSection() {
  document.getElementById('btn-refresh-status').addEventListener('click', refreshStatus);
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    if (!confirm('ログをクリアしますか？')) return;
    localStorage.removeItem(ADMIN_LOG_KEY);
    renderLog();
  });
  refreshStatus();
}

/* ========================================================
   §4. gemini.js へのステータス永続化パッチ
   ──────────────────────────────────────────────────────
   gemini.js の _updateStatus が window._geminiStatus を更新するとき
   localStorage にも書き込むよう、geminiStatusUpdate イベントを
   admin.html 内でも購読してキャッシュに保存する。
   （ゲーム画面側で発火したイベントは admin.html には届かないが、
     admin.html を開いているセッションで直接 AI 生成した場合に反映される）
   ======================================================== */
window.addEventListener('geminiStatusUpdate', (e) => {
  const s = e.detail;
  if (!s) return;
  try {
    // 既存エントリとマージして保存
    const prev = JSON.parse(localStorage.getItem('gemini_admin_status_v1') || '{}');
    localStorage.setItem('gemini_admin_status_v1', JSON.stringify({ ...prev, ...s }));
  } catch(_) {}
  refreshStatus();
  if (s.lastError) _appendLog(s.needsAdminRedo ? 'error' : 'warn', s.lastError);
});

/* ========================================================
   DOMContentLoaded
   ======================================================== */
document.addEventListener('DOMContentLoaded', () => {
  initApiKeySection();
  initModelSection();
  initLogSection();
});
