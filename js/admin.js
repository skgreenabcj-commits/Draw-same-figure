/**
 * admin.js  v1.1  (完全版)
 * 変更点 (v1.0 → v1.1):
 *   - BUG-C: §5 アラートログセクションを完全実装
 *     - rawJson の <details> 折りたたみ表示
 *     - initAlertLogSection() を DOMContentLoaded 内で呼び出し
 *     - クリアボタン (#btn-clear-alert-log) のイベントバインド
 *   - RISK-1: ALERT_LOG_KEY を GeminiAPI.getAlertLogKey() 経由で取得
 */

/* ============================================================
   §0. 定数
   ============================================================ */
const ADMIN_STATUS_KEY_LOCAL = 'gemini_admin_status_v1';
const MODEL_CACHE_KEY_LOCAL  = 'gemini_model_v3';
const ADMIN_LOG_KEY          = 'admin_log_v1';
const ADMIN_LOG_MAX          = 50;

// RISK-1 修正: ハードコードせず GeminiAPI 経由
function _getAlertLogKey() {
  return (window.GeminiAPI?.getAlertLogKey) ? window.GeminiAPI.getAlertLogKey() : 'gemini_alert_log_v1';
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
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit'
    });
  } catch (_) { return isoStr; }
}

function _showStatusMsg(id, msg, type = 'info') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent  = msg;
  el.className    = `admin-status-msg ${type}`;
  el.style.display = 'block';
}

function _isFlashLite(name) {
  return name.toLowerCase().includes('flash-lite');
}

/* ============================================================
   §3. API キーセクション
   ============================================================ */
function initApiKeySection() {
  const input   = document.getElementById('input-admin-apikey');
  const showBtn = document.getElementById('btn-admin-apikey-show');
  const saveBtn = document.getElementById('btn-admin-apikey-save');

  if (!input) return;

  // ロード
  const saved = GeminiAPI.loadApiKey();
  if (saved) {
    input.value = saved;
    _showStatusMsg('apikey-status', 'APIキーが設定されています', 'ok');
  }

  // 表示切替
  showBtn?.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    showBtn.textContent = input.type === 'password' ? '表示' : '隠す';
  });

  // 保存
  saveBtn?.addEventListener('click', () => {
    const val = input.value.trim();
    if (!val) { _showStatusMsg('apikey-status', 'APIキーを入力してください', 'warn'); return; }
    GeminiAPI.saveApiKey(val);
    _showStatusMsg('apikey-status', '保存しました', 'ok');
    _appendLog('info', 'APIキーを保存しました');
  });

  // キャッシュクリア
  document.getElementById('btn-clear-cache')?.addEventListener('click', () => {
    GeminiAPI.clearModelCache();
    _showStatusMsg('apikey-status', 'モデルキャッシュをクリアしました', 'info');
    _appendLog('info', 'モデルキャッシュをクリア');
  });
}

/* ============================================================
   §4. モデル優先度セクション
   ============================================================ */
function initModelSection() {
  const fetchBtn  = document.getElementById('btn-fetch-models');
  const saveBtn   = document.getElementById('btn-save-chain');
  const clearBtn  = document.getElementById('btn-clear-chain');
  const selects   = [
    document.getElementById('select-model-1'),
    document.getElementById('select-model-2'),
    document.getElementById('select-model-3')
  ];

  fetchBtn?.addEventListener('click', async () => {
    _showStatusMsg('model-status', 'モデルを取得中...', 'info');
    try {
      const models = await GeminiAPI.fetchLiveModels();
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
          opt.value = m;
          opt.textContent = _isFlashLite(m) ? `⭐ ${m} (推奨)` : m;
          sel.appendChild(opt);
        });
        sel.disabled = false;
      });
      // 推奨デフォルト
      const flashLite = models.find(_isFlashLite);
      if (flashLite && selects[0]) selects[0].value = flashLite;

      _renderCurrentChain();
      _showStatusMsg('model-status', `${models.length} 件取得`, 'ok');
      _appendLog('info', `モデル ${models.length} 件を取得`);
    } catch (err) {
      _showStatusMsg('model-status', `取得失敗: ${err.message}`, 'error');
      _appendLog('error', `モデル取得失敗: ${err.message}`);
    }
  });

  saveBtn?.addEventListener('click', () => {
    const chain = selects
      .map(sel => sel?.value || '')
      .filter(Boolean);

    if (chain.length === 0) {
      _showStatusMsg('model-status', '少なくとも1つのモデルを選択してください', 'warn');
      return;
    }
    // 重複チェック
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
    selects.forEach(sel => { if (sel) sel.disabled = true; });
    _renderCurrentChain();
    _showStatusMsg('model-status', 'チェーンをリセットしました', 'info');
    _appendLog('warn', 'チェーンをリセット');
  });

  _renderCurrentChain();
}

function _renderCurrentChain() {
  const container = document.getElementById('current-chain-display');
  if (!container) return;
  const chain = GeminiAPI.loadAdminChain();
  if (!chain || chain.length === 0) {
    container.innerHTML = '<span class="chain-empty">未設定（フォールバック使用）</span>';
    return;
  }
  container.innerHTML = chain.map((m, i) =>
    `<span class="chain-badge priority-${i + 1}">${i + 1}. ${m}</span>`
  ).join('');
}

/* ============================================================
   §5. ステータスセクション
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
    _appendLog('info', 'ステータスを手動更新');
  });
  document.getElementById('btn-clear-log')?.addEventListener('click', () => {
    _saveAdminLog([]);
    _renderLog();
    _appendLog('info', 'ログをクリア');
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
      lastErrorEl.textContent = `[${_fmtTs(st.lastErrorTs)}] ${st.lastError}`;
      lastErrorEl.style.display = 'block';
    } else {
      lastErrorEl.style.display = 'none';
    }
  }
}

function _renderLog() {
  const list = document.getElementById('admin-log-list');
  if (!list) return;
  const logs = _loadAdminLog();
  if (logs.length === 0) {
    list.innerHTML = '<li class="log-empty">ログなし</li>';
    return;
  }
  list.innerHTML = logs.map(entry => `
    <li class="log-entry log-${entry.level}">
      <span class="log-ts">${_fmtTs(entry.ts)}</span>
      <span class="log-level">${entry.level.toUpperCase()}</span>
      <span class="log-msg">${_escHtml(entry.message)}</span>
    </li>
  `).join('');
}

/* ============================================================
   §6. アラートログセクション（BUG-C 完全実装）
   ============================================================ */
function _loadAlertLog() {
  try {
    return JSON.parse(localStorage.getItem(_getAlertLogKey()) || '[]');
  } catch (_) { return []; }
}

/**
 * BUG-C 修正: rawJson の折りたたみ表示 / クリアボタンバインド / DOMContentLoaded 内呼び出し
 */
function initAlertLogSection() {
  _renderAlertLog();

  // クリアボタン
  document.getElementById('btn-clear-alert-log')?.addEventListener('click', () => {
    try { localStorage.removeItem(_getAlertLogKey()); } catch (_) {}
    _renderAlertLog();
    _appendLog('info', 'アラートログをクリア');
  });
}

function _renderAlertLog() {
  const list      = document.getElementById('alert-log-list');
  const countEl   = document.getElementById('alert-count');
  const logs      = _loadAlertLog();

  if (countEl) countEl.textContent = logs.length;

  if (!list) return;

  if (logs.length === 0) {
    list.innerHTML = '<li class="log-empty">アラートなし</li>';
    return;
  }

  list.innerHTML = logs.map((entry, idx) => {
    const badgeClass = {
      MODEL  : 'alert-type-model',
      PROMPT : 'alert-type-prompt',
      LEVEL  : 'alert-type-level'
    }[entry.alertType] || 'alert-type-unknown';

    // rawJson の折りたたみ（BUG-C 修正: <details><summary> で実装）
    const rawHtml = entry.rawJson
      ? `<details class="alert-raw-json">
           <summary>RAW JSON を表示</summary>
           <pre>${_escHtml(entry.rawJson)}</pre>
         </details>`
      : '';

    return `
      <li class="alert-log-entry">
        <div class="alert-log-header">
          <span class="alert-type-badge ${badgeClass}">${entry.alertType || 'UNKNOWN'}</span>
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
  if (status.alertType) {
    _appendLog('error', `アラート受信: [${status.alertType}] ${status.lastError || ''}`);
    _renderAlertLog();
  }
});

/* ============================================================
   §8. ユーティリティ: HTML エスケープ
   ============================================================ */
function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   §9. 初期化（BUG-C 修正: DOMContentLoaded 内で initAlertLogSection 呼び出し）
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initApiKeySection();
  initModelSection();
  initLogSection();
  initAlertLogSection(); // BUG-C 修正: ここで呼び出し確定
});
