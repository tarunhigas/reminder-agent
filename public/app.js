/* ── Reminder Agent — Frontend ──────────────────────────────────── */

const API = '/api';
let currentView = 'upcoming';
let pendingTaskPayload  = null;
let clashSuggestionIso  = null;

// ── Topbar date ───────────────────────────────────────────────────
document.getElementById('topbarDate').textContent =
  new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

// ── Browser notifications + SSE ───────────────────────────────────
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

function showBrowserNotification(title, message, tier) {
  showToast(title, message, tier);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, {
      body: message,
      tag: tier,
      requireInteraction: tier === 'start',
    });
  }
}

// Toast container
const toastContainer = document.createElement('div');
toastContainer.style.cssText =
  'position:fixed;bottom:22px;right:22px;display:flex;flex-direction:column;gap:8px;z-index:9999;pointer-events:none;';
document.body.appendChild(toastContainer);

const _toastStyle = document.createElement('style');
_toastStyle.textContent =
  '@keyframes slideInToast{from{transform:translateX(36px);opacity:0}to{transform:translateX(0);opacity:1}}';
document.head.appendChild(_toastStyle);

function showToast(title, message, tier) {
  const colors = { early: '#6c63ff', urgent: '#f0a500', start: '#4caf7d' };
  const color  = colors[tier] || '#6c63ff';
  const toast  = document.createElement('div');
  toast.style.cssText = `background:#1a1d27;border:1px solid ${color};border-left:4px solid ${color};
    color:#e8eaf6;padding:12px 16px;border-radius:10px;max-width:320px;
    box-shadow:0 4px 20px rgba(0,0,0,.5);pointer-events:all;cursor:pointer;
    animation:slideInToast .2s ease;`;
  toast.innerHTML = `<div style="font-weight:700;font-size:13px;margin-bottom:3px">${esc(title)}</div>
    <div style="font-size:12px;color:#7c82a8">${esc(message)}</div>`;
  toast.addEventListener('click', () => toast.remove());
  toastContainer.appendChild(toast);
  if (tier !== 'start') setTimeout(() => toast.remove(), tier === 'urgent' ? 12000 : 8000);
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('reminder', e => {
    try { const { title, message, tier } = JSON.parse(e.data); showBrowserNotification(title, message, tier); render(); }
    catch (_) {}
  });
  es.addEventListener('ping', () => {});
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}
connectSSE();

// ── DOM refs ──────────────────────────────────────────────────────
const taskList       = document.getElementById('taskList');
const viewTitle      = document.getElementById('viewTitle');
const clashBanner    = document.getElementById('clashBanner');
const clashBannerTxt = document.getElementById('clashBannerText');
const addModal       = document.getElementById('addModal');
const clashModal     = document.getElementById('clashModal');
const addTaskForm    = document.getElementById('addTaskForm');

// ── Routing ───────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    viewTitle.textContent = { upcoming: 'Upcoming', all: 'All Tasks', audit: 'Audit' }[currentView];
    render();
  });
});

// ── Add modal ─────────────────────────────────────────────────────
document.getElementById('addTaskBtn').addEventListener('click', openAddModal);
document.getElementById('addModalClose').addEventListener('click', closeAddModal);
document.getElementById('addCancelBtn').addEventListener('click', closeAddModal);

function openAddModal() {
  document.getElementById('f-date').value = todayStr();
  // reset recurrence to none
  document.querySelector('input[name="f-recurrence"][value="none"]').checked = true;
  // reset channels to desktop + browser
  setChannels('f-channel', ['desktop', 'browser']);
  addModal.classList.remove('hidden');
}
function closeAddModal() {
  addModal.classList.add('hidden');
  addTaskForm.reset();
}

document.getElementById('clashBannerClose').addEventListener('click', () =>
  clashBanner.classList.add('hidden'));

// ── Add task submit ───────────────────────────────────────────────
addTaskForm.addEventListener('submit', async e => {
  e.preventDefault();

  const title      = document.getElementById('f-title').value.trim();
  const date       = document.getElementById('f-date').value;
  const time       = document.getElementById('f-time').value;
  const duration   = parseInt(document.getElementById('f-duration').value, 10);
  const priority   = document.getElementById('f-priority').value;
  const notes      = document.getElementById('f-notes').value.trim();
  const tagsRaw    = document.getElementById('f-tags').value;
  const tags       = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const recurrence = document.querySelector('input[name="f-recurrence"]:checked')?.value || 'none';
  const notify_channels = getChannels('f-channel');

  if (!title || !date || !time || !duration) { alert('Please fill in all required fields.'); return; }
  if (notify_channels.length === 0) { alert('Pick at least one notification channel.'); return; }

  const start_time = buildIso(date, time);
  pendingTaskPayload = { title, start_time, duration, priority, recurrence, notify_channels, notes, tags };
  await submitTask(pendingTaskPayload, false);
});

async function submitTask(payload, autoResolve) {
  try {
    const res  = await fetch(`${API}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, auto_resolve: autoResolve }),
    });
    const data = await res.json();

    if (res.status === 409 && data.clash) {
      clashSuggestionIso = data.suggestion.iso;
      document.getElementById('clashSuggestion').textContent = data.suggestion.display;
      document.getElementById('clashList').innerHTML =
        data.clashes.map(c => `<li>📌 <strong>${esc(c.title)}</strong> — ${esc(c.displayStart)}</li>`).join('');
      closeAddModal();
      clashModal.classList.remove('hidden');
      return;
    }
    if (!res.ok) { showError(data); return; }

    closeAddModal();
    clashModal.classList.add('hidden');
    pendingTaskPayload = null;
    render();
  } catch (err) { alert(`Network error: ${err.message}`); }
}

// ── Clash modal ───────────────────────────────────────────────────
document.getElementById('clashCancelBtn').addEventListener('click', () => {
  clashModal.classList.add('hidden'); pendingTaskPayload = null;
});
document.getElementById('clashForceBtn').addEventListener('click', async () => {
  await submitTask({ ...pendingTaskPayload }, true);
});
document.getElementById('clashResolveBtn').addEventListener('click', async () => {
  await submitTask({ ...pendingTaskPayload, start_time: clashSuggestionIso }, false);
});

// ── Render (main) ─────────────────────────────────────────────────
async function render() {
  if (currentView === 'audit') { await renderAudit(); return; }

  try {
    const all  = currentView === 'all';
    const res  = await fetch(`${API}/tasks?all=${all}`);
    const data = await res.json();

    if (data.clashCount > 0) {
      clashBannerTxt.textContent =
        `${data.clashCount} scheduling clash${data.clashCount > 1 ? 'es' : ''} in your schedule.`;
      clashBanner.classList.remove('hidden');
    } else {
      clashBanner.classList.add('hidden');
    }

    if (data.tasks.length === 0) {
      taskList.innerHTML = `<div class="empty">
        <span class="empty-icon">🗓</span>
        No tasks scheduled.<br>Click <strong>+ Add Task</strong> to get started.
      </div>`;
      return;
    }

    taskList.innerHTML = all
      ? data.tasks.map(taskCard).join('')
      : renderGrouped(data.tasks);

    attachCardListeners();
  } catch (err) {
    taskList.innerHTML =
      `<div class="empty" style="color:var(--danger)">Failed to load: ${esc(err.message)}</div>`;
  }
}

// ── Grouped render (TODAY / TOMORROW / LATER) ─────────────────────
function renderGrouped(tasks) {
  const todayKey    = todayStr();
  const tomorrowKey = tomorrowStr();

  const groups = { today: [], tomorrow: [], later: [] };

  tasks.forEach(t => {
    const day = t.start_time.slice(0, 10);
    if (day === todayKey)         groups.today.push(t);
    else if (day === tomorrowKey) groups.tomorrow.push(t);
    else                          groups.later.push(t);
  });

  let html = '';

  if (groups.today.length) {
    html += `<div class="group-header today">Today</div>`;
    html += groups.today.map(taskCard).join('');
  }
  if (groups.tomorrow.length) {
    html += `<div class="group-header tomorrow">Tomorrow</div>`;
    html += groups.tomorrow.map(taskCard).join('');
  }
  if (groups.later.length) {
    // Sub-group later tasks by date label
    const byDate = {};
    groups.later.forEach(t => {
      const label = new Date(t.start_time).toLocaleDateString('en-US',
        { weekday: 'short', month: 'short', day: 'numeric' });
      (byDate[label] = byDate[label] || []).push(t);
    });
    Object.entries(byDate).forEach(([label, items]) => {
      html += `<div class="group-header">${label}</div>`;
      html += items.map(taskCard).join('');
    });
  }

  return html || `<div class="empty"><span class="empty-icon">✅</span>All caught up!</div>`;
}

// ── Task card ─────────────────────────────────────────────────────
function taskCard(t) {
  const clashBadge = t.hasClash  ? `<span class="clash-badge">⚡ CLASH</span>` : '';
  const doneBadge  = t.completed ? `<span class="done-badge">✓ Done</span>`    : '';
  const recurBadge = t.recurrence && t.recurrence !== 'none'
    ? `<span class="recur-badge">🔁 ${t.recurrence}</span>` : '';

  const countdown  = buildCountdown(t);

  const tags  = t.tags?.length
    ? `<div class="task-tags">${t.tags.map(g => `<span class="tag">#${esc(g)}</span>`).join('')}</div>` : '';
  const notes = t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : '';

  return `
  <div class="task-card ${t.hasClash ? 'clashing' : ''} ${t.completed ? 'completed' : ''}" data-id="${t.id}">
    <div class="task-priority-bar priority-${t.priority}"></div>
    <div class="task-body">
      <div class="task-title-row">
        <span class="task-title-text">${esc(t.title)}</span>
        ${clashBadge}${doneBadge}${recurBadge}
      </div>
      <div class="task-meta-row">
        <span class="task-time">${timeOnly(t.start_time)}</span>
        <span>⏱ ${t.duration} min</span>
        ${countdown}
        <span style="text-transform:capitalize;color:var(--muted)">${t.priority}</span>
      </div>
      ${tags}${notes}
    </div>
    <div class="task-actions">
      ${!t.completed ? `<button class="btn-icon edit-btn"   data-id="${t.id}" title="Edit">✏️</button>` : ''}
      ${!t.completed ? `<button class="btn-icon done-btn"   data-id="${t.id}" title="Mark done">✓</button>` : ''}
      <button class="btn-icon danger delete-btn" data-id="${t.id}" title="Delete">🗑</button>
    </div>
  </div>`;
}

function buildCountdown(t) {
  const diffMs  = new Date(t.start_time) - Date.now();
  const diffMin = Math.round(diffMs / 60000);

  if (t.completed)      return '';
  if (diffMin <= 0 && diffMin >= -t.duration)
    return `<span class="task-countdown startnow">🚀 Now</span>`;
  if (diffMin > 0 && diffMin <= 5)
    return `<span class="task-countdown urgent">⚠️ in ${diffMin}m</span>`;
  if (diffMin > 0 && diffMin <= 60)
    return `<span class="task-countdown urgent">in ${diffMin}m</span>`;
  if (diffMin > 0)
    return `<span class="task-countdown">${esc(t.fromNow)}</span>`;
  return '';
}

// ── Audit view ────────────────────────────────────────────────────
async function renderAudit() {
  taskList.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const res  = await fetch(`${API}/audit`);
    const data = await res.json();
    let html = `<div class="audit-card">
      <h3>📊 Schedule Health — ${data.taskCount} upcoming task(s)</h3>`;
    if (data.clashCount === 0) {
      html += `<div class="audit-clean">✅ No clashes. Schedule is clean!</div>`;
    } else {
      html += `<p style="color:var(--danger);margin-bottom:12px">⚡ ${data.clashCount} clash(es):</p>`;
      html += data.clashes.map(c => `
        <div class="clash-pair">
          <strong>${esc(c.a.title)}</strong> <span style="color:var(--muted)">${esc(c.a.displayStart)}</span>
          <br>↕ clashes with<br>
          <strong>${esc(c.b.title)}</strong> <span style="color:var(--muted)">${esc(c.b.displayStart)}</span>
        </div>`).join('');
    }
    html += '</div>';
    taskList.innerHTML = html;
  } catch (err) {
    taskList.innerHTML =
      `<div class="empty" style="color:var(--danger)">Audit failed: ${esc(err.message)}</div>`;
  }
}

// ── Card listeners ────────────────────────────────────────────────
function attachCardListeners() {
  document.querySelectorAll('.edit-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      const { task } = await fetch(`${API}/tasks/${btn.dataset.id}`).then(r => r.json());
      openEditModal(task);
    })
  );

  document.querySelectorAll('.done-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      await fetch(`${API}/tasks/${btn.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      render();
    })
  );

  document.querySelectorAll('.delete-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      await fetch(`${API}/tasks/${btn.dataset.id}`, { method: 'DELETE' });
      render();
    })
  );
}

// ── Edit modal ────────────────────────────────────────────────────
const editModal    = document.getElementById('editModal');
const editTaskForm = document.getElementById('editTaskForm');
let editClashSuggestionIso = null;
let editClashTimer         = null;

document.getElementById('editModalClose').addEventListener('click', closeEditModal);
document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);

function openEditModal(task) {
  const dt = new Date(task.start_time);
  document.getElementById('e-id').value       = task.id;
  document.getElementById('e-title').value    = task.title;
  document.getElementById('e-date').value     = dt.toLocaleDateString('en-CA');
  document.getElementById('e-time').value     = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  document.getElementById('e-duration').value = task.duration;
  document.getElementById('e-priority').value = task.priority;
  document.getElementById('e-notes').value    = task.notes || '';
  document.getElementById('e-tags').value     = (task.tags || []).join(', ');

  // Set recurrence radio
  const rec = task.recurrence || 'none';
  const recRadio = document.querySelector(`input[name="e-recurrence"][value="${rec}"]`);
  if (recRadio) recRadio.checked = true;

  // Set notification channels (normalise enum strings like "NotifyChannel.SLACK")
  const chans = (task.notify_channels || ['desktop', 'browser'])
    .map(c => String(c).split('.').pop().toLowerCase());
  setChannels('e-channel', chans);

  hideEditClashWarning();
  editClashSuggestionIso = null;
  editModal.classList.remove('hidden');
}

function closeEditModal() {
  editModal.classList.add('hidden');
  editTaskForm.reset();
  hideEditClashWarning();
  editClashSuggestionIso = null;
}

// Live clash check (debounced 600ms)
['e-date', 'e-time', 'e-duration'].forEach(id => {
  document.getElementById(id).addEventListener('input',  scheduleClashCheck);
  document.getElementById(id).addEventListener('change', scheduleClashCheck);
});

function scheduleClashCheck() {
  clearTimeout(editClashTimer);
  editClashTimer = setTimeout(runClashCheck, 600);
}

async function runClashCheck() {
  const id       = document.getElementById('e-id').value;
  const date     = document.getElementById('e-date').value;
  const time     = document.getElementById('e-time').value;
  const duration = parseInt(document.getElementById('e-duration').value, 10);
  if (!date || !time || !duration || duration <= 0) return;

  const start_time = buildIso(date, time);
  try {
    const res  = await fetch(`${API}/tasks/${id}/clash-check?start_time=${encodeURIComponent(start_time)}&duration=${duration}`);
    const data = await res.json();
    if (data.clashes?.length > 0) {
      editClashSuggestionIso = data.suggestion.iso;
      showEditClashWarning(data.clashes, data.hasCriticalClash, data.suggestion.display);
    } else {
      hideEditClashWarning();
      editClashSuggestionIso = null;
    }
  } catch (_) {}
}

function showEditClashWarning(clashes, hasCritical, suggDisplay) {
  const warning = document.getElementById('editClashWarning');
  const header  = document.getElementById('editClashHeader');
  const list    = document.getElementById('editClashList');
  const saveBtn = document.getElementById('editSaveBtn');
  const critN   = clashes.filter(c => c.priority === 'critical').length;

  if (hasCritical) {
    header.innerHTML = `🚨 Clashes with ${critN} critical task${critN > 1 ? 's' : ''} — move this task`;
    header.className = 'edit-clash-header critical';
    saveBtn.textContent = 'Save Anyway';
    saveBtn.classList.add('btn-warn-save');
  } else {
    header.innerHTML = `⚡ Clashes with ${clashes.length} task${clashes.length > 1 ? 's' : ''}`;
    header.className = 'edit-clash-header';
    saveBtn.textContent = 'Save Changes';
    saveBtn.classList.remove('btn-warn-save');
  }

  list.innerHTML = clashes.map(c => {
    const mark = c.priority === 'critical' ? ' <span class="crit-tag">CRITICAL</span>' : '';
    return `<li>📌 <strong>${esc(c.title)}</strong>${mark} — ${esc(c.displayStart)}</li>`;
  }).join('');

  document.getElementById('editSuggestion').textContent = suggDisplay;
  warning.classList.remove('hidden');
}

function hideEditClashWarning() {
  document.getElementById('editClashWarning').classList.add('hidden');
  const s = document.getElementById('editSaveBtn');
  if (s) { s.textContent = 'Save Changes'; s.classList.remove('btn-warn-save'); }
}

document.getElementById('editMoveBtn').addEventListener('click', () => {
  if (!editClashSuggestionIso) return;
  const dt = new Date(editClashSuggestionIso);
  document.getElementById('e-date').value = dt.toLocaleDateString('en-CA');
  document.getElementById('e-time').value = dt.toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit', hour12: false });
  hideEditClashWarning();
  editClashSuggestionIso = null;
});

editTaskForm.addEventListener('submit', async e => {
  e.preventDefault();
  const id         = document.getElementById('e-id').value;
  const title      = document.getElementById('e-title').value.trim();
  const date       = document.getElementById('e-date').value;
  const time       = document.getElementById('e-time').value;
  const duration   = parseInt(document.getElementById('e-duration').value, 10);
  const priority   = document.getElementById('e-priority').value;
  const notes      = document.getElementById('e-notes').value.trim();
  const tagsRaw    = document.getElementById('e-tags').value;
  const tags       = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const recurrence = document.querySelector('input[name="e-recurrence"]:checked')?.value || 'none';
  const notify_channels = getChannels('e-channel');

  if (!title || !date || !time || !duration) { alert('Please fill in all required fields.'); return; }
  if (notify_channels.length === 0) { alert('Pick at least one notification channel.'); return; }

  const start_time = buildIso(date, time);
  try {
    const res = await fetch(`${API}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start_time, duration, priority, recurrence, notify_channels, notes, tags }),
    });
    const data = await res.json();
    if (!res.ok) { showError(data); return; }
    closeEditModal();
    render();
  } catch (err) { alert(`Network error: ${err.message}`); }
});

// ── Auto-refresh every 60s ────────────────────────────────────────
setInterval(render, 60_000);

// ── Helpers ───────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function todayStr()    { return new Date().toISOString().slice(0, 10); }
function tomorrowStr() {
  const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10);
}

function buildIso(date, time) {
  const off  = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad  = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${date}T${time}:00${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

function timeOnly(iso) {
  return new Date(iso).toLocaleTimeString('en-US',
    { hour: 'numeric', minute: '2-digit', hour12: true });
}

// Read checked notification channels for a given checkbox group name
function getChannels(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`))
    .map(el => el.value);
}

// Set which channel checkboxes are checked
function setChannels(name, values) {
  document.querySelectorAll(`input[name="${name}"]`).forEach(el => {
    el.checked = values.includes(el.value);
  });
}

function showError(data) {
  let msg = data.detail ?? data.error ?? 'Unknown error';
  if (Array.isArray(msg)) msg = msg.map(e => e.msg || JSON.stringify(e)).join('\n');
  alert(`Error: ${msg}`);
}

// ── Ask Agent ─────────────────────────────────────────────────────
const agentModal    = document.getElementById('agentModal');
const agentInput    = document.getElementById('agentInput');
const agentPreview  = document.getElementById('agentPreview');
const agentExamples = document.getElementById('agentExamples');

document.getElementById('askAgentBtn').addEventListener('click', openAgentModal);
document.getElementById('agentModalClose').addEventListener('click', closeAgentModal);
document.getElementById('agentCancelBtn').addEventListener('click', closeAgentModal);

function openAgentModal() {
  agentInput.value = '';
  agentPreview.classList.add('hidden');
  agentExamples.classList.remove('hidden');
  agentModal.classList.remove('hidden');
  setTimeout(() => agentInput.focus(), 80);
}
function closeAgentModal() {
  agentModal.classList.add('hidden');
  agentPreview.classList.add('hidden');
}

// Example chips fill the input
document.querySelectorAll('.agent-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    agentInput.value = chip.textContent.trim();
    agentInput.focus();
  });
});

// Parse on button click or Enter key
document.getElementById('agentParseBtn').addEventListener('click', runAgentParse);
agentInput.addEventListener('keydown', e => { if (e.key === 'Enter') runAgentParse(); });

async function runAgentParse() {
  const text = agentInput.value.trim();
  if (!text) { agentInput.focus(); return; }

  const btn = document.getElementById('agentParseBtn');
  btn.textContent = '…';
  btn.disabled = true;

  try {
    const res  = await fetch(`${API}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();

    if (!res.ok) { showError(data); return; }

    // Fill preview fields
    document.getElementById('ap-title').value    = data.title || '';
    document.getElementById('ap-date').value     = data.date  || todayStr();
    document.getElementById('ap-time').value     = data.time  || '09:00';
    document.getElementById('ap-duration').value = data.duration || 30;
    document.getElementById('ap-priority').value = data.priority || 'medium';

    // Reset recurrence + channels
    document.querySelector('input[name="ap-recurrence"][value="none"]').checked = true;
    setChannels('ap-channel', ['desktop', 'browser']);

    // Confidence indicator
    const confEl = document.getElementById('agentConfidence');
    const confMap = {
      high:   { text: '✓ High confidence',   color: 'var(--success)'  },
      medium: { text: '~ Medium confidence', color: 'var(--warning)'  },
      low:    { text: '⚠ Low confidence',    color: 'var(--danger)'   },
    };
    const conf = confMap[data.confidence] || confMap.medium;
    confEl.textContent  = conf.text;
    confEl.style.color  = conf.color;

    agentExamples.classList.add('hidden');
    agentPreview.classList.remove('hidden');

  } catch (err) {
    alert(`Network error: ${err.message}`);
  } finally {
    btn.textContent = 'Parse →';
    btn.disabled = false;
  }
}

// Confirm — build payload from preview fields and submit
document.getElementById('agentConfirmBtn').addEventListener('click', async () => {
  const title      = document.getElementById('ap-title').value.trim();
  const date       = document.getElementById('ap-date').value;
  const time       = document.getElementById('ap-time').value;
  const duration   = parseInt(document.getElementById('ap-duration').value, 10);
  const priority   = document.getElementById('ap-priority').value;
  const recurrence = document.querySelector('input[name="ap-recurrence"]:checked')?.value || 'none';
  const notify_channels = getChannels('ap-channel');

  if (!title || !date || !time || !duration) {
    alert('Please fill in all required fields.');
    return;
  }
  if (notify_channels.length === 0) { alert('Pick at least one notification channel.'); return; }

  const start_time = buildIso(date, time);
  pendingTaskPayload = { title, start_time, duration, priority, recurrence, notify_channels, notes: '', tags: [] };
  closeAgentModal();
  await submitTask(pendingTaskPayload, false);
});

// ── Boot ──────────────────────────────────────────────────────────
render();
