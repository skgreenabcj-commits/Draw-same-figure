/**
 * admin.js  v1.3
 * 変更点 (v1.2 → v1.3):
 *   - ERR-3: initModelSection の _renderCurrentChain 呼び出しタイミングを
 *            全バインド完了後に移動し、クラッシュで saveBtn が未バインドになる問題を修正
 *            fetchLiveModels の戻り値が配列でない場合の型ガードを追加
 *   - ERR-4: _renderLog を <ul><li> 平文から <table><tr> 形式に変更し判読性を回復
 *            admin.html の tbody#admin-log-list に対して tr を描画
 */

/* ============================================================
   §0. 定数
   ============================================================ */
const ADMIN_STATUS_KEY_LOCAL = 'gemini_admin_status_v1';
const MODEL_CACHE_KEY_LOCAL  = 'gemini_model_v3';
const ADMIN_LOG_KEY          = 'admin_log_v1';
const ADMIN_LOG_MAX          = 50;

function _getAlertLogKey() {
  return (window.GeminiAPI?.getAlertLogKey)
    ? window.GeminiAPI.getAlertLogKey()
    : 'gemini_alert_log_v1';
}

/* ============================================================
   §1. 管理ログ（操作ログ）
   ============================================================ */
function _loadAdminLog() {
  try { return JSON.parse(localStorage.getItem(ADMIN_LOG_KEY) || '[]'); } catch (_) { return []; }
}
function _saveAdminLog(logs) {
  try { localStorage.setItem(ADMIN_LOG_KEY, JSON.stringify(logs)); } catch (_) {}
}
function _appendLog(level, message) {
  const logs = _loadAdminLog();
  logs.unshift({ ts: new Date().toISOString(), level, message });
  if (logs.length > ADMIN_LOG_MAX) logs.length = ADMIN_LOG_MAX;
  _saveAdminLog(logs);
  _renderLog();
}

/* ============================================================
   §2. ユーティリティ
   ============================================================ */
function _fmtTs(isoStr) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (_) { return isoStr; }
}

function _showStatusMsg(id, msg, type = 'info') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent   = msg;
  el.className     = `admin-status-msg ${type}`;
  el.style.display = 'block';
}

function _isFlashLite(name) {
  return name.toLowerCase().includes('flash-lite');
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   §3. API キーセクション
   ============================================================ */
function initApiKeySection() {
  const input   = document.getElementById('input-admin-apikey');
  const showBtn = document.getElementById('btn-admin-apikey-show');
  const saveBtn = document.getElementById('btn-admin-apikey-save');

  if (!input) return;

  const saved = GeminiAPI.loadApiKey();
  if (saved) {
    input.value = saved;
    _showStatusMsg('apikey-status', 'APIキーが設定されています', 'ok');
  }

  showBtn?.addEventListener('click', () => {
    input.type          = input.type === 'password' ? 'text' : 'password';
    showBtn.textContent = input.type === 'password' ? '表示' : '隠す';
  });

  saveBtn?.addEventListener('click', () => {
    const val = input.value.trim();
    if (!val) {
      _showStatusMsg('apikey-status', 'APIキーを入力してください', 'warn');
      return;
    }
    GeminiAPI.saveApiKey(val);
    _showStatusMsg('apikey-status', '保存しました', 'ok');
    _appendLog('info', 'APIキーを保存しました');
  });

  document.getElementById('btn-clear-cache')?.addEventListener('click', () => {
    GeminiAPI.clearModelCache();
    _showStatusMsg('apikey-status', 'モデルキャッシュをクリアしました', 'info');
    _appendLog('info', 'モデルキャッシュをクリア');
  });
}

/* ============================================================
   §4. モデル優先度セクション（ERR-3 修正）
   ============================================================ */
function initModelSection() {
  const fetchBtn = document.getElementById('btn-fetch-models');
  const saveBtn  = document.getElementById('btn-save-chain');
  const clearBtn = document.getElementById('btn-clear-chain');
  const selects  = [
    document.getElementById('select-model-1'),
    document.getElementById('select-model-2'),
    document.getElementById('select-model-3')
  ];

  // ERR-3 修正: fetchBtn のハンドラ内で型ガードを追加
  fetchBtn?.addEventListener('click', async () => {
    _showStatusMsg('model-status', 'モデルを取得中...', 'info');
    try {
      const models = await GeminiAPI.fetchLiveModels();

      // 型ガード: 配列でない場合はエラー扱い
      if (!Array.isArray(models)) {
        throw new Error('fetchLiveModels did not return an array');
      }

      selects.forEach((sel, i) => {
        if (!sel) return;
        sel.innerHTML = '';
        if (i > 0) {
          const none = document.createElement('option');
          none.value = ''; none.textContent = '— なし —';
          sel.appendChild(none);
        }
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value       = m;
          opt.textContent = _isFlashLite(m) ? `⭐ ${m} (推奨)` : m;
          sel.appendChild(opt);
        });
        sel.disabled = false;
      });

      const flashLite = models.find(_isFlashLite);
      if (flashLite && selects[0]) selects[0].value = flashLite;

      _renderCurrentChain();
      _showStatusMsg('model-status', `${models.length} 件取得`, 'ok');
      _appendLog('info', `ライブモデル取得成功: ${models.join(', ')}`);

    } catch (err) {
      _showStatusMsg('model-status', `取得失敗: ${err.message}`, 'error');
      _appendLog('error', `モデル取得失敗: ${err.message}`);
    }
  });

  // ERR-3 修正: saveBtn のバインドを独立させクラッシュの影響を受けない構造に
  saveBtn?.addEventListener('click', () => {
    const chain = selects.map(sel => sel?.value || '').filter(Boolean);
    if (chain.length === 0) {
      _showStatusMsg('model-status', '少なくとも1つのモデルを選択してください', 'warn');
      return;
    }
    if (new Set(chain).size !== chain.length) {
      _showStatusMsg('model-status', '重複するモデルがあります', 'warn');
      return;
    }
    GeminiAPI.saveAdminChain(chain);
    _renderCurrentChain();
    _showStatusMsg('model-status', 'チェーンを保存しました', 'ok');
    _appendLog('info', `チェーン保存: ${chain.join(' → ')}`);
  });

  clearBtn?.addEventListener('click', () => {
    GeminiAPI.clearAdminChain();
    selects.forEach(sel => { if (sel) { sel.disabled = true; sel.innerHTML = '<option value="">— モデルを取得してください —</option>'; } });
    _renderCurrentChain();
    _showStatusMsg('model-status', 'チェーンをリセットしました', 'info');
    _appendLog('warn', 'チェーンをリセット');
  });

  // ERR-3 修正: 全バインド完了後に _renderCurrentChain を呼び出す
  _renderCurrentChain();
}

function _renderCurrentChain() {
  const container = document.getElementById('current-chain-display');
  if (!container) return;
  try {
    const chain = GeminiAPI.loadAdminChain(); // v5.9.3 で型ガード済み
    if (!chain || chain.length === 0) {
      container.innerHTML = '<span class="chain-empty">未設定（フォールバック使用）</span>';
      return;
    }
    container.innerHTML = chain.map((m, i) =>
      `<span class="chain-badge priority-${i + 1}">${i + 1}. ${_escHtml(m)}</span>`
    ).join('');
  } catch (err) {
    container.innerHTML = '<span class="chain-empty">チェーン読み込みエラー</span>';
    console.error('[admin] _renderCurrentChain error:', err);
  }
}

/* ============================================================
   §5. ステータス・操作ログセクション（ERR-4 修正）
   ============================================================ */
function _loadAdminStatus() {
  try { return JSON.parse(localStorage.getItem(ADMIN_STATUS_KEY_LOCAL) || '{}'); } catch (_) { return {}; }
}

function initLogSection() {
  _renderStatus();
  _renderLog();

  document.getElementById('btn-refresh-status')?.addEventListener('click', () => {
    _renderStatus();
    _renderLog();
    _renderAlertLog();
    _appendLog('info', 'ステータスを手動更新');
  });

  document.getElementById('btn-clear-log')?.addEventListener('click', () => {
    _saveAdminLog([]);
    _renderLog();
  });
}

function _renderStatus() {
  const st = _loadAdminStatus();

  const errCountEl = document.getElementById('status-error-count');
  if (errCountEl) errCountEl.textContent = st.errorCount ?? 0;

  const lastModelEl = document.getElementById('status-last-model');
  if (lastModelEl) lastModelEl.textContent = st.lastSuccessModel || '—';

  const needsUpdateEl = document.getElementById('status-needs-update');
  if (needsUpdateEl) needsUpdateEl.textContent = st.needsUpdate ? '要更新' : '正常';

  const lastErrorEl = document.getElementById('status-last-error');
  if (lastErrorEl) {
    if (st.lastError) {
      lastErrorEl.textContent   = `[${_fmtTs(st.lastErrorTs)}] ${st.lastError}`;
      lastErrorEl.style.display = 'block';
    } else {
      lastErrorEl.style.display = 'none';
    }
  }
}

/**
 * ERR-4 修正: <ul><li> 平文 → <table><tbody> 形式に変更
 * admin.html の tbody#admin-log-list に対して <tr> を描画する
 */
function _renderLog() {
  const tbody = document.getElementById('admin-log-list');
  if (!tbody) return;
  const logs = _loadAdminLog();

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="log-empty">ログなし</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(entry => `
    <tr class="log-row log-row-${_escHtml(entry.level)}">
      <td class="log-td-ts">${_fmtTs(entry.ts)}</td>
      <td class="log-td-level">
        <span class="log-level-badge log-level-${_escHtml(entry.level)}">
          ${_escHtml(entry.level.toUpperCase())}
        </span>
      </td>
      <td class="log-td-msg">${_escHtml(entry.message)}</td>
    </tr>
  `).join('');
}

/* ============================================================
   §6. アラートログセクション
   ============================================================ */
function _loadAlertLog() {
  try {
    return JSON.parse(localStorage.getItem(_getAlertLogKey()) || '[]');
  } catch (_) { return []; }
}

function initAlertLogSection() {
  _renderAlertLog();
  document.getElementById('btn-clear-alert-log')?.addEventListener('click', () => {
    try { localStorage.removeItem(_getAlertLogKey()); } catch (_) {}
    _renderAlertLog();
    _appendLog('info', 'アラートログをクリア');
  });
}

function _renderAlertLog() {
  const list    = document.getElementById('alert-log-list');
  const countEl = document.getElementById('alert-count');
  const logs    = _loadAlertLog();

  if (countEl) countEl.textContent = logs.length;
  if (!list) return;

  if (logs.length === 0) {
    list.innerHTML = '<li class="log-empty">アラートなし</li>';
    return;
  }

  list.innerHTML = logs.map(entry => {
    const badgeClass = {
      MODEL  : 'alert-type-model',
      PROMPT : 'alert-type-prompt',
      LEVEL  : 'alert-type-level'
    }[entry.alertType] || 'alert-type-unknown';

    const rawHtml = entry.rawJson
      ? `<details class="alert-raw-json">
           <summary>RAW JSON を表示</summary>
           <pre>${_escHtml(entry.rawJson)}</pre>
         </details>`
      : '';

    return `
      <li class="alert-log-entry">
        <div class="alert-log-header">
          <span class="alert-type-badge ${badgeClass}">${_escHtml(entry.alertType || 'UNKNOWN')}</span>
          <span class="alert-log-ts">${_fmtTs(entry.ts)}</span>
        </div>
        <div class="alert-log-model">🤖 ${_escHtml(entry.model || '—')}</div>
        <div class="alert-log-msg">${_escHtml(entry.message || '')}</div>
        ${rawHtml}
      </li>
    `;
  }).join('');
}

/* ============================================================
   §7. geminiStatusUpdate リスナー
   ============================================================ */
window.addEventListener('geminiStatusUpdate', (e) => {
  const status = e.detail || {};
  try {
    const stored = JSON.parse(localStorage.getItem(ADMIN_STATUS_KEY_LOCAL) || '{}');
    const merged = Object.assign({}, stored, status, { _ts: new Date().toISOString() });
    localStorage.setItem(ADMIN_STATUS_KEY_LOCAL, JSON.stringify(merged));
  } catch (_) {}

  _renderStatus();
  _renderAlertLog(); // 常時呼び出し（件数カード最新化）

  if (status.alertType) {
    _appendLog('error', `アラート受信: [${status.alertType}] ${status.lastError || ''}`);
  }
});

/* ============================================================
   §8. 初期化
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initApiKeySection();
  initModelSection();
  initLogSection();
  initAlertLogSection();
});
