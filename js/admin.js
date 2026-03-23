/**
 * admin.js  v1.1
 * 管理者設定画面（admin.html）専用ロジック
 *
 * 【v1.1 変更点】
 *   - §5 アラートログセクションを新規追加
 *     - localStorage('gemini_alert_log_v1') からアラートを読み込み表示
 *     - 各エントリ: ts（日時）・alertType・message・model・rawJson を表示
 *     - 「アラートログをクリア」ボタンを追加
 *   - §3 の admin_log_v1 は操作ログとして維持（混在しない）
 *
 * 依存: gemini.js（saveApiKey, loadApiKey, fetchLiveModels,
 *                  saveAdminChain, loadAdminChain, clearAdminChain,
 *                  clearModelCache, getAlertLogKey）
 */

const ADMIN_STATUS_KEY_LOCAL = 'gemini_admin_status_v1';
const MODEL_CACHE_KEY_LOCAL  = 'gemini_model_v3';

/* ========================================================
   操作ログストレージ（admin.js 内の操作記録）
   ======================================================== */
const ADMIN_LOG_KEY = 'admin_log_v1';
const ADMIN_LOG_MAX = 50;

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
   §1. APIキーセクション（変更なし）
   ======================================================== */
function initApiKeySection() {
  const inputEl = document.getElementById('input-admin-apikey');
  const eyeBtn  = document.getElementById('btn-admin-apikey-show');
  const eyeIcon = document.getElementById('apikey-eye-icon');
  const saveBtn = document.getElementById('btn-admin-apikey-save');

  const saved = loadApiKey();
  if (saved) { inputEl.value = saved; _setStatus('apikey-status', '✅ APIキーが設定されています', 'ok'); }

  eyeBtn.addEventListener('click', () => {
    const isPassword = inputEl.type === 'password';
    inputEl.type      = isPassword ? 'text' : 'password';
    eyeIcon.className = isPassword ? 'fa fa-eye-slash' : 'fa fa-eye';
  });

  saveBtn.addEventListener('click', () => {
    const key = inputEl.value.trim();
    if (key) {
      saveApiKey(key);
      clearModelCache();
      _setStatus('apikey-status', '✅ APIキーを保存しました', 'ok');
      _appendLog('info', 'APIキーを更新しました');
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
   §2. モデル優先順位セクション（変更なし）
   ======================================================== */
let _liveModels = [];

async function fetchAndPopulateModels(apiKey) {
  _setStatus('models-fetch-status', '🔄 モデル一覧を取得中...', 'info');
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

  const current = loadAdminChain() || [];

  [1, 2, 3].forEach(priority => {
    const sel = document.getElementById(`select-model-${priority}`);
    sel.innerHTML = '';

    if (priority > 1) {
      const noneOpt = document.createElement('option');
      noneOpt.value       = '';
      noneOpt.textContent = '— なし —';
      sel.appendChild(noneOpt);
    }

    models.forEach(m => {
      const opt       = document.createElement('option');
      opt.value       = m;
      opt.textContent = _isLite(m) ? `${m}　★推奨` : m;
      sel.appendChild(opt);
    });

    sel.disabled = false;

    if (current[priority - 1]) {
      sel.value = current[priority - 1];
    } else if (priority === 1) {
      const lite = models.find(m => _isLite(m));
      sel.value = lite || models[0] || '';
    }

    _updatePriorityNote(priority);
    sel.addEventListener('change', () => _updatePriorityNote(priority));
  });

  document.getElementById('btn-save-chain').disabled = false;
  _renderCurrentChain();
}

function _updatePriorityNote(priority) {
  const sel  = document.getElementById(`select-model-${priority}`);
  const note = document.getElementById(`note-model-${priority}`);
  if (!sel || !note) return;
  note.textContent = _isLite(sel.value) ? '★ 推奨モデルです' : '';
  note.className   = _isLite(sel.value) ? 'priority-note priority-note--recommend' : 'priority-note';
}

function _renderCurrentChain() {
  const chain  = loadAdminChain();
  const box    = document.getElementById('current-chain-display');
  const badges = document.getElementById('current-chain-badges');
  if (!chain || chain.length === 0) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  badges.innerHTML  = chain.map((m, i) =>
    `<span class="chain-badge chain-badge--${i+1}">${i+1}位: ${m}</span>`
  ).join('');
}

function saveChain() {
  const sel1 = document.getElementById('select-model-1').value;
  const sel2 = document.getElementById('select-model-2').value;
  const sel3 = document.getElementById('select-model-3').value;

  if (!sel1) { _setStatus('chain-save-status', '⚠️ 第1優先モデルを選択してください', 'warn'); return; }

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
    [1,2,3].forEach(p => {
      const sel = document.getElementById(`select-model-${p}`);
      sel.innerHTML = `<option value="">— モデルを取得してください —</option>`;
      sel.disabled  = true;
    });
    document.getElementById('btn-save-chain').disabled = true;
  });

  _renderCurrentChain();
  const apiKey = loadApiKey();
  if (apiKey) fetchAndPopulateModels(apiKey);
}

/* ========================================================
   §3. ステータス／操作ログセクション（変更なし）
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
  if (lastError.includes('CHANGE AI model') || lastError.includes('CHECK AI prompt'))
    return '👉 推奨アクション: 「AIモデル優先順位」セクションで別のモデルを選択してください。';
  if (lastError.includes('CONSIDER changing'))
    return '👉 推奨アクション: 「AIモデル優先順位」のモデルを変更するか、レベル設定を見直してください。';
  if (lastError.includes('エラーが'))
    return '👉 推奨アクション: モデル設定を確認し、利用可能なモデルに更新してください。';
  return '👉 推奨アクション: ゲーム画面を再読み込みして再試行してください。';
}

function refreshStatus() {
  const status = _loadAdminStatus();

  document.getElementById('val-error-count').textContent =
    status.errorCount !== undefined ? String(status.errorCount) : '—';
  document.getElementById('val-last-model').textContent =
    status.lastSuccessModel || '—';
  document.getElementById('val-needs-redo').textContent =
    status.needsAdminRedo ? '⚠️ 更新が必要' : (status.errorCount > 0 ? '確認推奨' : '✅ 問題なし');

  const errorBox = document.getElementById('last-error-box');
  if (status.lastError) {
    errorBox.style.display = 'block';
    document.getElementById('last-error-msg').textContent    = status.lastError;
    document.getElementById('last-error-action').textContent = _getRecommendedAction(status.lastError);
  } else {
    errorBox.style.display = 'none';
  }

  renderLog();
}

function _loadAdminStatus() {
  const base = { errorCount: 0, lastError: '', needsAdminRedo: false, lastSuccessModel: '' };
  try {
    const raw = localStorage.getItem(ADMIN_STATUS_KEY_LOCAL);
    if (raw) return { ...base, ...JSON.parse(raw) };
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
  document.getElementById('btn-refresh-status').addEventListener('click', () => {
    refreshStatus();
    renderAlertLog(); // 【v1.1】アラートログも同時に更新
  });
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    if (!confirm('ログをクリアしますか？')) return;
    localStorage.removeItem(ADMIN_LOG_KEY);
    renderLog();
  });
  refreshStatus();
}

/* ========================================================
   §4. geminiStatusUpdate パッチ（変更なし）
   ======================================================== */
window.addEventListener('geminiStatusUpdate', (e) => {
  const s = e.detail;
  if (!s) return;
  try {
    const prev = JSON.parse(localStorage.getItem('gemini_admin_status_v1') || '{}');
    localStorage.setItem('gemini_admin_status_v1', JSON.stringify({ ...prev, ...s }));
  } catch(_) {}
  refreshStatus();
  if (s.lastError) _appendLog(s.needsAdminRedo ? 'error' : 'warn', s.lastError);
});

/* ========================================================
   §5. 【v1.1】アラートログセクション
   ======================================================== */

/**
 * alertType バッジの表示ラベルと色クラスを返す。
 */
function _alertTypeMeta(alertType) {
  switch (alertType) {
    case 'MODEL':  return { label: 'MODEL',  cls: 'alert-type--model'  };
    case 'PROMPT': return { label: 'PROMPT', cls: 'alert-type--prompt' };
    case 'LEVEL':  return { label: 'LEVEL',  cls: 'alert-type--level'  };
    default:       return { label: alertType || '?', cls: 'alert-type--other' };
  }
}

/**
 * アラートログを DOM に描画する。
 * rawJson は折りたたみ可能な <details> で表示する。
 */
function renderAlertLog() {
  const key     = getAlertLogKey();           // 'gemini_alert_log_v1'
  const listEl  = document.getElementById('alert-log-list');
  if (!listEl) return;

  let entries = [];
  try { entries = JSON.parse(localStorage.getItem(key) || '[]'); } catch(_) {}

  // アラート件数バッジを更新
  const countEl = document.getElementById('val-alert-count');
  if (countEl) countEl.textContent = String(entries.length);

  if (entries.length === 0) {
    listEl.innerHTML = '<p class="admin-log-empty">アラートはまだありません。</p>';
    return;
  }

  listEl.innerHTML = [...entries].reverse().map((e, idx) => {
    const meta      = _alertTypeMeta(e.alertType);
    const rawSafe   = e.rawJson
      ? String(e.rawJson).replace(/</g,'&lt;').replace(/>/g,'&gt;')
      : '(なし)';
    const detailsId = `alert-raw-${idx}`;
    return `
      <div class="alert-log-entry alert-log-entry--${(e.alertType||'other').toLowerCase()}">
        <div class="alert-log-header">
          <span class="alert-log-ts">${_fmt(e.ts)}</span>
          <span class="alert-type-badge ${meta.cls}">${meta.label}</span>
          <span class="alert-log-model">${e.model || '—'}</span>
        </div>
        <div class="alert-log-msg">${e.message || ''}</div>
        <details class="alert-log-raw" id="${detailsId}">
          <summary class="alert-log-raw-summary">JSON出力を表示</summary>
          <pre class="alert-log-raw-pre">${rawSafe}</pre>
        </details>
      </div>`;
  }).join('');
}

function initAlertLogSection() {
  const clearBtn = document.getElementById('btn-clear-alert-log');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!confirm('アラートログをクリアしますか？')) return;
      const key = getAlertLogKey();
      localStorage.removeItem(key);
      renderAlertLog();
      _appendLog('warn', 'アラートログをクリアしました');
    });
  }
  renderAlertLog();
}

/* ========================================================
   DOMContentLoaded
   ======================================================== */
document.addEventListener('DOMContentLoaded', () => {
  initApiKeySection();
  initModelSection();
  initLogSection();
  initAlertLogSection(); // 【v1.1】
});
