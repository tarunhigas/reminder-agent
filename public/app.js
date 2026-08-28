/* ── Reminder Agent — Frontend ──────────────────────────────────────── */

const API = '/api';
let currentView = 'upcoming';
let pendingTaskPayload = null;   // held during clash resolution
let clashSuggestionIso = null;

// ── Browser Notifications + SSE ───────────────────────────────────────

// Request notification permission on load
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

function showBrowserNotification(title, message, tier) {
  // In-page toast (always shown)
  showToast(title, message, tier);

  // Native browser notification (only if permitted and page is not focused)
  if ('Notification' in window && Notification.permission === 'granted') {
    const icons = { early: '🕐', urgent: '⚠️', start: '🚀' };
    new Notification(title, {
      body: message,
      icon: '/favicon.ico',
      tag: tier,          // replaces previous notification of same tier
      requireInteraction: tier === 'start',  // stays until dismissed at start time
    });
  }
}

// Toast container (injected once)
const toastContainer = document.createElement('div');
toastContainer.id = 'toastContainer';
toastContainer.style.cssText = `
  position: fixed; bottom: 24px; right: 24px;
  display: flex; flex-direction: column; gap: 10px;
  z-index: 9999; pointer-events: none;
`;
document.body.appendChild(toastContainer);

function showToast(title, message, tier) {
  const colors = { early: '#6c63ff', urgent: '#f0a500', start: '#4caf7d' };
  const color  = colors[tier] || '#6c63ff';

  const toast = document.createElement('div');
  toast.style.cssText = `
    background: #1a1d27; border: 1px solid ${color};
    border-left: 4px solid ${color};
    color: #e8eaf6; padding: 14px 18px; border-radius: 10px;
    max-width: 340px; box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    pointer-events: all; cursor: pointer;
    animation: slideInToast .25s ease;
  `;
  toast.innerHTML = `
    <div style="font-weight:700;font-size:14px;margin-bottom:4px">${esc(title)}</div>
    <div style="font-size:13px;color:#7c82a8">${esc(message)}</div>
  `;

  const style = document.createElement('style');
  style.textContent = `@keyframes slideInToast{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}`;
  document.head.appendChild(style);

  toast.addEventListener('click', () => toast.remove());
  toastContainer.appendChild(toast);

  // Auto-dismiss: 8s for early, 12s for urgent, stays for start
  if (tier !== 'start') {
    setTimeout(() => toast.remove(), tier === 'urgent' ? 12000 : 8000);
  }
}

// Connect to SSE stream
function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('reminder', (e) => {
    try {
      const { title, message, tier } = JSON.parse(e.data);
      showBrowserNotification(title, message, tier);
      // Refresh task list so reminded state updates
      render();
    } catch (_) {}
  });

  es.addEventListener('ping', () => { /* keepalive — do nothing */ });

  es.onerror = () => {
    es.close();
    // Reconnect after 5s if the connection drops
    setTimeout(connectSSE, 5000);
  };
}

connectSSE();

// ── DOM refs ──────────────────────────────────────────────────────────
const taskList       = document.getElementById('taskList');
const viewTitle      = document.getElementById('viewTitle');
const clashBanner    = document.getElementById('clashBanner');
const clashBannerTxt = document.getElementById('clashBannerText');

const addModal       = document.getElementById('addModal');
const clashModal     = document.getElementById('clashModal');
const addTaskForm    = document.getElementById('addTaskForm');

// ── Routing ───────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    const titles = { upcoming: 'Upcoming Tasks', all: 'All Tasks', audit: 'Schedule Audit' };
    viewTitle.textContent = titles[currentView];
    render();
  });
});

// ── Add Task button ───────────────────────────────────────────────────
document.getElementById('addTaskBtn').addEventListener('click', openAddModal);
document.getElementById('addModalClose').addEventListener('click', closeAddModal);
document.getElementById('addCancelBtn').addEventListener('click', closeAddModal);

// Pre-fill today's date
function openAddModal() {
  document.getElementById('f-date').value = todayStr();
  addModal.classList.remove('hidden');
}
function closeAddModal() {
  addModal.classList.add('hidden');
  addTaskForm.reset();
}

// ── Clash banner close ────────────────────────────────────────────────
document.getElementById('clashBannerClose').addEventListener('click', () => {
  clashBanner.classList.add('hidden');
});

// ── Add Task form submit ──────────────────────────────────────────────
addTaskForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title    = document.getElementById('f-title').value.trim();
  const date     = document.getElementById('f-date').value;
  const time     = document.getElementById('f-time').value;
  const duration = parseInt(document.getElementById('f-duration').value, 10);
  const priority = document.getElementById('f-priority').value;
  const notes    = document.getElementById('f-notes').value.trim();
  const tagsRaw  = document.getElementById('f-tags').value;
  const tags     = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

  if (!title || !date || !time || !duration) {
    alert('Please fill in all required fields.');
    return;
  }

  const startTime = `${date}T${time}:00`;

  // Attach local timezone offset so the server doesn't treat it as UTC
  const localOffset = -new Date().getTimezoneOffset();
  const sign = localOffset >= 0 ? '+' : '-';
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const tzSuffix = `${sign}${pad(localOffset / 60)}:${pad(localOffset % 60)}`;
  const startTimeWithTz = `${date}T${time}:00${tzSuffix}`;

  pendingTaskPayload = { title, start_time: startTimeWithTz, duration, priority, notes, tags };
  await submitTask(pendingTaskPayload, false);
});

async function submitTask(payload, autoResolve) {
  try {
    const res = await fetch(`${API}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, auto_resolve: autoResolve }),
    });

    const data = await res.json();

    if (res.status === 409 && data.clash) {
      // Show clash modal
      clashSuggestionIso = data.suggestion.iso;
      document.getElementById('clashSuggestion').textContent = data.suggestion.display;

      const list = document.getElementById('clashList');
      list.innerHTML = data.clashes.map(c =>
        `<li>📌 <strong>${esc(c.title)}</strong> — ${esc(c.displayStart)}</li>`
      ).join('');

      closeAddModal();
      clashModal.classList.remove('hidden');
      return;
    }

    if (!res.ok) {
      // FastAPI validation errors come as data.detail (string or array)
      let msg = data.detail ?? data.error ?? 'Unknown error';
      if (Array.isArray(msg)) {
        msg = msg.map(e => e.msg || JSON.stringify(e)).join('\n');
      }
      alert(`Error: ${msg}`);
      return;
    }

    closeAddModal();
    clashModal.classList.add('hidden');
    pendingTaskPayload = null;
    render();
  } catch (err) {
    alert(`Network error: ${err.message}`);
  }
}

// ── Clash modal actions ───────────────────────────────────────────────
document.getElementById('clashCancelBtn').addEventListener('click', () => {
  clashModal.classList.add('hidden');
  pendingTaskPayload = null;
});

document.getElementById('clashForceBtn').addEventListener('click', async () => {
  // Save at original time (skip clash check)
  await submitTask({ ...pendingTaskPayload, autoResolve: true }, true);
});

document.getElementById('clashResolveBtn').addEventListener('click', async () => {
  // Move to suggested free slot
  const updated = { ...pendingTaskPayload, start_time: clashSuggestionIso };
  await submitTask(updated, false);
});

// ── Render ────────────────────────────────────────────────────────────
async function render() {
  taskList.innerHTML = '<div class="loading">Loading…</div>';

  if (currentView === 'audit') {
    await renderAudit();
    return;
  }

  try {
    const all = currentView === 'all';
    const res  = await fetch(`${API}/tasks?all=${all}`);
    const data = await res.json();

    // Clash banner
    if (data.clashCount > 0) {
      clashBannerTxt.textContent =
        `${data.clashCount} scheduling clash${data.clashCount > 1 ? 'es' : ''} detected in your schedule.`;
      clashBanner.classList.remove('hidden');
    } else {
      clashBanner.classList.add('hidden');
    }

    if (data.tasks.length === 0) {
      taskList.innerHTML = '<div class="empty">No tasks here. Add one to get started!</div>';
      return;
    }

    taskList.innerHTML = data.tasks.map(taskCard).join('');
    attachCardListeners();
  } catch (err) {
    taskList.innerHTML = `<div class="empty" style="color:var(--danger)">Failed to load tasks: ${esc(err.message)}</div>`;
  }
}

async function renderAudit() {
  try {
    const res  = await fetch(`${API}/audit`);
    const data = await res.json();

    let html = `<div class="audit-card">
      <h3>📊 Schedule Health — ${data.taskCount} upcoming task(s)</h3>`;

    if (data.clashCount === 0) {
      html += `<div class="audit-clean">✅ No clashes detected. Your schedule is clean!</div>`;
    } else {
      html += `<p style="color:var(--danger);margin-bottom:14px;">⚡ ${data.clashCount} clash(es) found:</p>`;
      html += data.clashes.map(c => `
        <div class="clash-pair">
          <strong>${esc(c.a.title)}</strong> <span style="color:var(--muted)">${esc(c.a.displayStart)}</span>
          <br/>↕ clashes with<br/>
          <strong>${esc(c.b.title)}</strong> <span style="color:var(--muted)">${esc(c.b.displayStart)}</span>
        </div>`).join('');
    }

    html += `</div>`;
    taskList.innerHTML = html;
  } catch (err) {
    taskList.innerHTML = `<div class="empty" style="color:var(--danger)">Audit failed: ${esc(err.message)}</div>`;
  }
}

// ── Task card HTML ────────────────────────────────────────────────────
function taskCard(t) {
  const clashBadge = t.hasClash  ? `<span class="clash-badge">⚡ CLASH</span>` : '';
  const doneBadge  = t.completed ? `<span class="done-badge">✓ Done</span>`   : '';
  const tags = t.tags?.length
    ? `<div class="task-tags">${t.tags.map(g => `<span class="tag">#${esc(g)}</span>`).join('')}</div>`
    : '';
  const notes = t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : '';

  return `
  <div class="task-card ${t.hasClash ? 'clashing' : ''} ${t.completed ? 'completed' : ''}" data-id="${t.id}">
    <div class="task-priority-bar priority-${t.priority}"></div>
    <div class="task-body">
      <div class="task-title">
        ${esc(t.title)} ${clashBadge} ${doneBadge}
      </div>
      <div class="task-meta">
        <span>📅 ${esc(t.displayStart)}</span>
        <span>⏱ ${t.duration} min</span>
        <span>🕐 ${esc(t.fromNow)}</span>
        <span style="text-transform:capitalize">🏷 ${t.priority}</span>
      </div>
      ${tags}
      ${notes}
    </div>
    <div class="task-actions">
      ${!t.completed ? `<button class="btn-icon edit-btn" data-id="${t.id}" title="Edit">✏️</button>` : ''}
      ${!t.completed ? `<button class="btn-icon done-btn" data-id="${t.id}" title="Mark done">✓</button>` : ''}
      <button class="btn-icon danger delete-btn" data-id="${t.id}" title="Delete">🗑</button>
    </div>
  </div>`;
}

function attachCardListeners() {
  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res  = await fetch(`${API}/tasks/${btn.dataset.id}`);
      const data = await res.json();
      openEditModal(data.task);
    });
  });

  document.querySelectorAll('.done-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`${API}/tasks/${btn.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      render();
    });
  });

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      await fetch(`${API}/tasks/${btn.dataset.id}`, { method: 'DELETE' });
      render();
    });
  });
}

// ── Edit Modal ────────────────────────────────────────────────────────
const editModal    = document.getElementById('editModal');
const editTaskForm = document.getElementById('editTaskForm');

document.getElementById('editModalClose').addEventListener('click', closeEditModal);
document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);

let editClashSuggestionIso = null;  // free slot from clash-check
let editClashCheckTimer    = null;  // debounce timer

function openEditModal(task) {
  const dt = new Date(task.start_time);
  const localDate = dt.toLocaleDateString('en-CA');
  const localTime = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  document.getElementById('e-id').value       = task.id;
  document.getElementById('e-title').value    = task.title;
  document.getElementById('e-date').value     = localDate;
  document.getElementById('e-time').value     = localTime;
  document.getElementById('e-duration').value = task.duration;
  document.getElementById('e-priority').value = task.priority;
  document.getElementById('e-notes').value    = task.notes || '';
  document.getElementById('e-tags').value     = (task.tags || []).join(', ');

  // Clear any previous clash warning
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

// Live clash check — fires 600ms after user stops changing date/time/duration
function scheduleEditClashCheck() {
  clearTimeout(editClashCheckTimer);
  editClashCheckTimer = setTimeout(runEditClashCheck, 600);
}

async function runEditClashCheck() {
  const id       = document.getElementById('e-id').value;
  const date     = document.getElementById('e-date').value;
  const time     = document.getElementById('e-time').value;
  const duration = parseInt(document.getElementById('e-duration').value, 10);

  if (!date || !time || !duration || duration <= 0) return;

  const localOffset = -new Date().getTimezoneOffset();
  const sign = localOffset >= 0 ? '+' : '-';
  const pad  = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const tzSuffix = `${sign}${pad(localOffset / 60)}:${pad(localOffset % 60)}`;
  const start_time = `${date}T${time}:00${tzSuffix}`;

  try {
    const res  = await fetch(`${API}/tasks/${id}/clash-check?start_time=${encodeURIComponent(start_time)}&duration=${duration}`);
    const data = await res.json();

    if (data.clashes && data.clashes.length > 0) {
      editClashSuggestionIso = data.suggestion.iso;
      showEditClashWarning(data.clashes, data.hasCriticalClash, data.suggestion.display);
    } else {
      hideEditClashWarning();
      editClashSuggestionIso = null;
    }
  } catch (_) { /* silent — clash check is best-effort */ }
}

function showEditClashWarning(clashes, hasCritical, suggestionDisplay) {
  const warning = document.getElementById('editClashWarning');
  const header  = document.getElementById('editClashHeader');
  const list    = document.getElementById('editClashList');
  const saveBtn = document.getElementById('editSaveBtn');

  const criticalCount = clashes.filter(c => c.priority === 'critical').length;

  if (hasCritical) {
    header.innerHTML = `<span class="clash-critical-icon">🚨</span> Clashes with ${criticalCount} critical task${criticalCount > 1 ? 's' : ''} — you should move this task`;
    header.className = 'edit-clash-header critical';
    saveBtn.textContent = 'Save Anyway';
    saveBtn.classList.add('btn-warn-save');
  } else {
    header.innerHTML = `<span>⚡</span> Clashes with ${clashes.length} task${clashes.length > 1 ? 's' : ''}`;
    header.className = 'edit-clash-header';
    saveBtn.textContent = 'Save Changes';
    saveBtn.classList.remove('btn-warn-save');
  }

  list.innerHTML = clashes.map(c => {
    const critMark = c.priority === 'critical' ? ' <span class="crit-tag">CRITICAL</span>' : '';
    return `<li>📌 <strong>${esc(c.title)}</strong>${critMark} — ${esc(c.displayStart)}</li>`;
  }).join('');

  document.getElementById('editSuggestion').textContent = suggestionDisplay;
  warning.classList.remove('hidden');
}

function hideEditClashWarning() {
  document.getElementById('editClashWarning').classList.add('hidden');
  const saveBtn = document.getElementById('editSaveBtn');
  if (saveBtn) {
    saveBtn.textContent = 'Save Changes';
    saveBtn.classList.remove('btn-warn-save');
  }
}

// "Move here" button — fills in the suggested free slot
document.getElementById('editMoveBtn').addEventListener('click', () => {
  if (!editClashSuggestionIso) return;
  const dt = new Date(editClashSuggestionIso);
  document.getElementById('e-date').value = dt.toLocaleDateString('en-CA');
  document.getElementById('e-time').value = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  hideEditClashWarning();
  editClashSuggestionIso = null;
});

// Attach live clash check to date/time/duration inputs
['e-date', 'e-time', 'e-duration'].forEach(id => {
  document.getElementById(id).addEventListener('change', scheduleEditClashCheck);
  document.getElementById(id).addEventListener('input',  scheduleEditClashCheck);
});

editTaskForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const id       = document.getElementById('e-id').value;
  const title    = document.getElementById('e-title').value.trim();
  const date     = document.getElementById('e-date').value;
  const time     = document.getElementById('e-time').value;
  const duration = parseInt(document.getElementById('e-duration').value, 10);
  const priority = document.getElementById('e-priority').value;
  const notes    = document.getElementById('e-notes').value.trim();
  const tagsRaw  = document.getElementById('e-tags').value;
  const tags     = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

  if (!title || !date || !time || !duration) {
    alert('Please fill in all required fields.');
    return;
  }

  const localOffset = -new Date().getTimezoneOffset();
  const sign = localOffset >= 0 ? '+' : '-';
  const pad  = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const tzSuffix = `${sign}${pad(localOffset / 60)}:${pad(localOffset % 60)}`;
  const start_time = `${date}T${time}:00${tzSuffix}`;

  try {
    const res = await fetch(`${API}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start_time, duration, priority, notes, tags }),
    });

    const data = await res.json();

    if (!res.ok) {
      let msg = data.detail ?? data.error ?? 'Unknown error';
      if (Array.isArray(msg)) msg = msg.map(e => e.msg || JSON.stringify(e)).join('\n');
      alert(`Error: ${msg}`);
      return;
    }

    closeEditModal();
    render();
  } catch (err) {
    alert(`Network error: ${err.message}`);
  }
});

// ── Auto-refresh every 60s ────────────────────────────────────────────
setInterval(render, 60_000);

// ── Helpers ───────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Boot ──────────────────────────────────────────────────────────────
render();
