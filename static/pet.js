// ── Auth guard ────────────────────────────────────────────────────────────────
// If the session expires (or is missing), any /api call returns 401 — bounce to login.
(function () {
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    return _fetch.apply(this, args).then((res) => {
      if (res.status === 401) {
        const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
        if (url.includes('/api/')) window.location.href = '/login';
      }
      return res;
    });
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Blob companion — AI reactions, familiarity / energy / happiness
// ─────────────────────────────────────────────────────────────────────────────

// ── Persistent local stats ───────────────────────────────────────────────────
// v3: fresh defaults so stats aren't stuck at 100
const STATS_KEY = 'blob_v3_stats';

function defaultStats() {
  return { familiarity: 5, energy: 60, happiness: 45, lastOpen: Date.now() };
}

function loadLocalStats() {
  try { return Object.assign(defaultStats(), JSON.parse(localStorage.getItem(STATS_KEY) || '{}')); }
  catch { return defaultStats(); }
}

let localStats = loadLocalStats();

// Decay while away: happiness -4/hr, energy -6/hr (makes the pet feel alive)
const hoursAway = Math.min(12, (Date.now() - localStats.lastOpen) / 3600000);
localStats.happiness = Math.max(15, localStats.happiness - hoursAway * 4);
localStats.energy    = Math.max(5,  localStats.energy    - hoursAway * 6);
localStats.lastOpen  = Date.now();
saveLocalStats();

function saveLocalStats() {
  localStorage.setItem(STATS_KEY, JSON.stringify(localStats));
}

function clampStat(v) { return Math.min(100, Math.max(0, v)); }

// familiarity tiers
function tier() {
  const f = localStats.familiarity;
  if (f < 20) return 'terrified';
  if (f < 42) return 'shy';
  if (f < 65) return 'cautious';
  if (f < 85) return 'friendly';
  return 'bonded';
}

function getBlobMood() {
  if (currentExpression) return `mood-${currentExpression}`;
  if (localStats.energy < 15) return 'mood-sleepy';
  switch (tier()) {
    case 'terrified': return 'mood-scared';
    case 'shy':       return 'mood-sad';
    case 'cautious':  return 'mood-curious';
    case 'friendly':  return 'mood-happy';
    case 'bonded':    return 'mood-excited';
  }
  return 'mood-curious';
}

// ── Expression override (temporary face) ─────────────────────────────────────
let currentExpression = null;
let expressionTimer   = null;

function showExpression(expr, duration = 2200) {
  clearTimeout(expressionTimer);
  currentExpression = expr;
  blobEl.className  = `blob mood-${expr}`;
  expressionTimer   = setTimeout(() => {
    currentExpression = null;
    refreshMood();
  }, duration);
}

function refreshMood() {
  if (currentExpression) return;
  blobEl.className = `blob ${getBlobMood()}`;
}

// ── AI reaction (replaces nudge) ─────────────────────────────────────────────
async function react(event) {
  try {
    const res = await fetch('/api/pet/react', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        stats: {
          familiarity: Math.round(localStats.familiarity),
          energy:      Math.round(localStats.energy),
          happiness:   Math.round(localStats.happiness),
          pending:     tasks.filter(t => !t.done).length,
        }
      })
    });
    const data = await res.json();

    if (data.message) say(data.message, 4000);

    if (data.effects) {
      const fx = data.effects;
      if (fx.happiness)   localStats.happiness   = clampStat(localStats.happiness   + fx.happiness);
      if (fx.energy)      localStats.energy      = clampStat(localStats.energy      + fx.energy);
      if (fx.familiarity) localStats.familiarity = clampStat(localStats.familiarity + fx.familiarity);
      saveLocalStats();

      const expr = fx.expression;
      if (expr && expr !== 'normal') {
        const dur = (expr === 'punched' || expr === 'dizzy') ? 2500 : 2000;
        showExpression(expr, dur);
        if (expr === 'punched') {
          bvx += (Math.random() - 0.5) * 1.2;
          bvy -= 0.8 + Math.random() * 0.4; // bounce upward
          pulseUntil = performance.now() + 600;
        }
        if (expr === 'dizzy') {
          bvx  = (Math.random() - 0.5) * 0.9;
          bvy  = (Math.random() - 0.5) * 0.9;
        }
      } else {
        refreshMood();
      }
    }
  } catch (e) {
    refreshMood();
  }
}

// ── SVG icon library ─────────────────────────────────────────────────────────
const IC = {
  flame:    (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C9.5 5 8 7.5 9 10c.6 1.5-.2 3-1.5 3.5C8 11 6 10 5 11.5c-1.5 2-.5 5 1.5 6.5C7.5 19.5 9.5 20 12 20s4.5-.5 5.5-2c2-1.5 3-4.5 1.5-6.5-1-1.5-3-.5-2.5 2-1.3-.5-2.1-2-1.5-3.5 1-2.5-.5-5-3-8z"/></svg>`,
  flameSoft:(s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c0 0-4 5-4 9a4 4 0 0 0 8 0c0-4-4-9-4-9z"/><path d="M12 17c0 0-2-2-2-4"/></svg>`,
  coin:     (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a2.5 2.5 0 0 0-5 0c0 2 5 3 5 5a2.5 2.5 0 0 1-5 0"/><line x1="12" y1="7" x2="12" y2="8.5"/><line x1="12" y1="15.5" x2="12" y2="17"/></svg>`,
  brain:    (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.96-3 2.5 2.5 0 0 1-1.32-4.24 3 3 0 0 1 .34-5.58 2.5 2.5 0 0 1 1.96-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.96-3 2.5 2.5 0 0 0 1.32-4.24 3 3 0 0 0-.34-5.58 2.5 2.5 0 0 0-1.96-3A2.5 2.5 0 0 0 14.5 2z"/></svg>`,
  heart:    (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  heartOut: (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  bolt:     (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  star:     (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" xmlns="http://www.w3.org/2000/svg"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  sparkle:  (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.4 7.6H22l-6.4 4.7 2.4 7.7L12 17.3l-6 4.7 2.4-7.7L2 9.6h7.6z"/></svg>`,
  trendUp:  (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
  snowflake:(s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 7l-5 5-5-5"/><path d="M17 17l-5-5-5 5"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M7 7l5 5 5-5"/><path d="M7 17l5-5 5 5"/></svg>`,
  pause:    (s=12,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  play:     (s=12,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  refresh:  (s=12,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  people:   (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  leaf:     (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 22C2 22 12 22 17 17c5-5 5-15 5-15S12 2 7 7C2 12 2 22 2 22z"/></svg>`,
  diamond:  (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}"><path d="M12 2L2 9l10 13L22 9z"/></svg>`,
  piggy:    (s=14,c='currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9a7 7 0 1 0-11.87 5H6v2h1v2h2v-1.13A7 7 0 0 0 19 9z"/><path d="M21 9h-2"/><path d="M12 6v1"/></svg>`,
};

// ── Helper functions ──────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000);
  if (diff < 1)    return 'just now';
  if (diff < 60)   return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff/60)}h ago`;
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
}

// ── Notifications ─────────────────────────────────────────────────────────────
const NOTIFS_KEY         = 'blob_notifs';
const NOTIFS_ENABLED_KEY = 'blob_notifs_enabled';
const NOTIF_MAX          = 40;

const NOTIF_COLORS = {
  task_added:    '#60a5fa',
  task_done:     '#4ade80',
  task_undone:   '#555',
  task_deleted:  '#f87171',
  habit_checked: '#fbbf24',
  goal_added:    '#a78bfa',
  goal_progress: '#a78bfa',
  focus_added:   '#34d399',
  journal_added: '#f472b6',
  budget_added:  '#60a5fa',
  habit_added:   '#fbbf24',
  chat_action:   '#c084fc',
};

function notifsEnabled() {
  return localStorage.getItem(NOTIFS_ENABLED_KEY) !== 'false';
}

function loadNotifs() {
  try { return JSON.parse(localStorage.getItem(NOTIFS_KEY) || '[]'); }
  catch { return []; }
}

function saveNotifs(notifs) {
  localStorage.setItem(NOTIFS_KEY, JSON.stringify(notifs));
}

function addNotif(type, message) {
  if (!notifsEnabled()) return;
  const notifs = loadNotifs();
  notifs.unshift({ type, message, time: Date.now() });
  saveNotifs(notifs.slice(0, NOTIF_MAX));
  updateNotifBadge();
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const count = loadNotifs().length;
  badge.classList.toggle('hidden', count === 0 || !notifsEnabled());
}

function renderNotifs() {
  const notifs = loadNotifs();
  const list   = document.getElementById('notifList');
  if (!notifs.length) {
    list.innerHTML = '<div class="notif-empty">no notifications yet</div>';
    return;
  }
  list.innerHTML = notifs.map(n => {
    const color = NOTIF_COLORS[n.type] || '#555';
    const ago   = fmtDate(new Date(n.time).toISOString());
    return `<div class="notif-item">
      <div class="notif-dot" style="background:${color}"></div>
      <div class="notif-body">
        <div class="notif-msg">${esc(n.message)}</div>
        <div class="notif-time">${ago}</div>
      </div>
    </div>`;
  }).join('');
}

function openNotifs() {
  document.getElementById('notifPanel').classList.add('open');
  renderNotifs();
}

function closeNotifs() {
  document.getElementById('notifPanel').classList.remove('open');
}

// ── Screen navigation ─────────────────────────────────────────────────────────
const screens  = document.querySelectorAll('.screen');
const navItems = document.querySelectorAll('.nav-item[data-screen]');

let prevScreen = 'home';

function updateStatBars() {
  const f = Math.round(localStats.familiarity);
  const e = Math.round(localStats.energy);
  const h = Math.round(localStats.happiness);

  document.getElementById('barFamiliarity').style.width = `${f}%`;
  document.getElementById('barEnergy').style.width      = `${e}%`;
  document.getElementById('barHappiness').style.width   = `${h}%`;
  document.getElementById('valFamiliarity').textContent = f;
  document.getElementById('valEnergy').textContent      = e;
  document.getElementById('valHappiness').textContent   = h;

  const t     = tier();
  const badge = document.getElementById('tierBadge');
  if (badge) { badge.textContent = t; badge.className = `tier-badge tier-${t}`; }

  // Sync coin display on heart screen
  const hcd = document.getElementById('heartCoinDisplay');
  if (hcd) hcd.textContent = petData.coins;
}

const HERO_PERSIST_SCREENS = new Set(['heart']);
const BLOB_HIDDEN_SCREENS  = new Set(['memories', 'achievements', 'settings']);

function showScreen(name, from) {
  clearTimeout(heroReturnTimer);
  if (from) prevScreen = from;
  if (shopPreviewMode && name !== 'shop') exitShopPreview();
  if (heroMode && !HERO_PERSIST_SCREENS.has(name)) exitHeroMode();
  blobEl.style.opacity        = BLOB_HIDDEN_SCREENS.has(name) ? '0' : '';
  blobEl.style.pointerEvents  = BLOB_HIDDEN_SCREENS.has(name) ? 'none' : '';
  screens.forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
  navItems.forEach(n => n.classList.toggle('active', n.dataset.screen === name));
  if (name === 'heart') { loadTodayCount(); updateStatBars(); syncBlobPreview(); loadEquippedDisplay(); enterHeroMode(); }
  if (name === 'memories') loadMemories();
  if (name !== 'shop') stopTryOn();
  if (name === 'achievements') loadAchievements();
  if (name === 'shop') {
    shopCurrentTier = 'all';
    document.querySelectorAll('.shop-tab').forEach(t => t.classList.toggle('active', t.dataset.tier === 'all'));
    loadShop();
    // Defer until the DOM has painted and stage rect is available
    requestAnimationFrame(() => requestAnimationFrame(enterShopPreview));
  }
  if (name === 'focus') initFocusScreen();
  if (name === 'habits') loadHabits();
  if (name === 'goals') loadGoals();
  if (name === 'navigation') loadNavigation();
  if (name === 'journal') loadJournal();
  if (name === 'settings') loadUsage();
  scheduleNextRest(1000);
}

navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    showScreen(btn.dataset.screen);
    attractToEdge(btn, 'top', 1400);
  });
});

document.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.back || prevScreen));
});

// ── Add screen cells ──────────────────────────────────────────────────────────
document.querySelectorAll('.add-cell').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    if (type === 'task') {
      openModal();
    } else {
      const screenMap = {
        focus:   'focus',
        goal:    'goals',
        navigation: 'navigation',
        habit:   'habits',
        journal: 'journal',
      };
      const screenName = screenMap[type] || type;
      showScreen(screenName, 'add');
    }
    attractToEdge(btn, 'top', 900);
  });
});

// ── Heart menu buttons ────────────────────────────────────────────────────────
document.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    if (action === 'memories')     showScreen('memories', 'heart');
    if (action === 'shop')         showScreen('shop', 'heart');
    if (action === 'achievements') showScreen('achievements', 'heart');
    if (action === 'settings')     showScreen('settings', 'heart');
    attractToEdge(btn, 'left', 1000);
  });
});

// ── Add item buttons (in sub-screen headers) ──────────────────────────────────
document.querySelectorAll('.add-item-btn[data-open]').forEach(btn => {
  btn.addEventListener('click', () => openContentModal(btn.dataset.open));
});

// ── Modal ─────────────────────────────────────────────────────────────────────
const modalOverlay = document.getElementById('modalOverlay');
const taskForm     = document.getElementById('taskForm');
const taskInput    = document.getElementById('taskInput');
let selectedCategory = 'general';

const BUILT_IN_CATS  = ['general', 'work', 'study', 'health'];
const TAG_PALETTE    = ['#f87171','#fb923c','#fbbf24','#4ade80','#34d399','#60a5fa','#a78bfa','#f472b6'];
const CUSTOM_TAGS_KEY = 'blob_custom_tags';

function tagColorFromName(name) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}

function getCustomTags() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_TAGS_KEY) || '[]'); }
  catch { return []; }
}

function saveCustomTags(tags) {
  localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(tags));
}

function makeTagHtml(category) {
  const cat = category || 'general';
  if (BUILT_IN_CATS.includes(cat)) {
    return `<span class="task-tag task-tag-${cat}">${cat}</span>`;
  }
  const col = tagColorFromName(cat);
  const r = parseInt(col.slice(1,3),16), g = parseInt(col.slice(3,5),16), b = parseInt(col.slice(5,7),16);
  return `<span class="task-tag" style="color:${col};background:rgba(${r},${g},${b},0.12);border-color:rgba(${r},${g},${b},0.3)">${esc(cat)}</span>`;
}

function renderModalChips() {
  const container = document.getElementById('categoryChips');
  const customTags = getCustomTags();
  container.innerHTML = '';

  [...BUILT_IN_CATS, ...customTags.map(t => t.name)].forEach(cat => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-chip' + (cat === selectedCategory ? ' active' : '');
    btn.dataset.cat = cat;
    btn.textContent = cat;
    if (!BUILT_IN_CATS.includes(cat) && cat === selectedCategory) {
      const col = tagColorFromName(cat);
      const r = parseInt(col.slice(1,3),16), g = parseInt(col.slice(3,5),16), b = parseInt(col.slice(5,7),16);
      btn.style.cssText = `border-color:${col};color:${col};background:rgba(${r},${g},${b},0.1)`;
    }
    btn.addEventListener('click', () => { selectedCategory = cat; renderModalChips(); });
    container.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'category-chip category-chip-add';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', showTagInput);
  container.appendChild(addBtn);
}

function showTagInput() {
  const container = document.getElementById('categoryChips');
  if (container.querySelector('.tag-input')) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'tag-input';
  inp.placeholder = 'tag name...';
  inp.maxLength = 16;

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const val = inp.value.trim().toLowerCase().replace(/\s+/g, '-');
    if (val && !BUILT_IN_CATS.includes(val)) {
      const tags = getCustomTags();
      if (!tags.find(t => t.name === val)) {
        tags.push({ name: val });
        saveCustomTags(tags);
      }
      selectedCategory = val;
    }
    renderModalChips();
  }

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; renderModalChips(); }
  });
  inp.addEventListener('blur', () => setTimeout(commit, 100));
  container.appendChild(inp);
  setTimeout(() => inp.focus(), 30);
}

function setCategory(cat) {
  selectedCategory = cat;
  renderModalChips();
}

function openModal() {
  modalOverlay.classList.remove('hidden');
  selectedCategory = 'general';
  renderModalChips();
  setTimeout(() => taskInput.focus(), 60);
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  taskForm.reset();
  selectedCategory = 'general';
}

document.getElementById('closeModal').addEventListener('click', closeModal);
document.getElementById('cancelModal').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

// ── Toast ─────────────────────────────────────────────────────────────────────
const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}

// ── Speech bubble ─────────────────────────────────────────────────────────────
const speechEl     = document.getElementById('speech');
const speechBubble = document.getElementById('speechBubble');
let speechTimer = null;

function say(text, duration = 3500) {
  speechEl.textContent = text;
  speechBubble.classList.add('visible');
  clearTimeout(speechTimer);
  speechTimer = setTimeout(() => speechBubble.classList.remove('visible'), duration);
}

// ── API pet state (coins / streak / level only) ───────────────────────────────
let petData = { coins: 0, streak: 0, level: 1, hunger: 50, total_completed: 0 };

function updatePetUI(pet) {
  petData = pet;
  document.getElementById('statCoins').textContent   = pet.coins;
  document.getElementById('statStreak').textContent  = pet.streak;
  document.getElementById('statLevel').textContent   = pet.level;
  const hcd = document.getElementById('heartCoinDisplay');
  if (hcd) hcd.textContent = pet.coins;
  document.getElementById('feedCoinAmt').textContent = pet.coins;
}

async function loadPet() {
  try {
    const res = await fetch('/api/pet');
    updatePetUI(await res.json());
  } catch (e) {}
}

// ── Home screen helpers ───────────────────────────────────────────────────────
let lastHabitStreak = null;

function updateHomeGreeting() {
  const h  = new Date().getHours();
  const greet = h < 12 ? 'good morning' : h < 17 ? 'good afternoon' : h < 21 ? 'good evening' : 'good night';
  const days   = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const now = new Date();
  const el = document.getElementById('homeGreeting');
  const de = document.getElementById('homeDate');
  if (el) el.textContent = greet;
  if (de) de.textContent = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
}

function renderHomeHabits() {
  const streak = lastHabitStreak;
  if (!streak) return;
  const today  = new Date().toISOString().slice(0, 10);
  const active = (chatHabits || []).filter(h => !h.paused);
  const done   = active.filter(h => h.last_done && h.last_done.slice(0, 10) === today).length;

  const bigEl  = document.getElementById('homeHabitsDone');
  const lblEl  = document.getElementById('homeHabitsLabel');
  const dotEl  = document.getElementById('homeWeekDots');

  if (bigEl) bigEl.textContent = active.length ? `${done}/${active.length}` : '–';
  if (lblEl) lblEl.textContent = active.length ? 'today' : 'no habits';
  if (dotEl) dotEl.innerHTML = (streak.week_done || [])
    .map(on => `<div class="home-week-dot${on ? ' on' : ''}"></div>`).join('');
}

function renderHomeGoal() {
  const goals = chatGoals || [];
  const titleEl = document.getElementById('homeGoalTitle');
  const fillEl  = document.getElementById('homeGoalFill');
  const pctEl   = document.getElementById('homeGoalPct');
  if (!titleEl) return;

  if (!goals.length) {
    titleEl.textContent = 'no goals yet';
    if (fillEl) fillEl.style.width = '0%';
    if (pctEl)  pctEl.textContent = '—';
    return;
  }
  const sorted = [...goals].sort((a, b) => {
    if (a.deadline && b.deadline) return new Date(a.deadline) - new Date(b.deadline);
    return a.deadline ? -1 : b.deadline ? 1 : 0;
  });
  const g   = sorted[0];
  const pct = Math.round(g.progress || 0);
  titleEl.textContent = g.title;
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (pctEl)  pctEl.textContent  = `${pct}%`;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
const taskListEl  = document.getElementById('taskList');
const taskCountEl = document.getElementById('taskCount');
let tasks = [];

function renderTasks() {
  const done  = tasks.filter(t => t.done).length;
  const total = tasks.length;
  if (taskCountEl) taskCountEl.textContent = `${done}/${total} tasks`;

  // Progress ring
  const arc = document.getElementById('homeProgressArc');
  if (arc) {
    const circ = 138.2;
    arc.style.strokeDashoffset = total > 0 ? circ * (1 - done / total) : circ;
  }
  const doneEl  = document.getElementById('homeTasksDone');
  const totalEl = document.getElementById('homeTasksTotal');
  if (doneEl)  doneEl.textContent  = done;
  if (totalEl) totalEl.textContent = total;

  if (!tasks.length) {
    taskListEl.innerHTML = '<li class="empty-state">no tasks yet — add one!</li>';
    return;
  }
  taskListEl.innerHTML = tasks.map(t => {
    const safe = esc(t.title);
    return `
      <li class="task-item ${t.done ? 'done' : ''}">
        <button class="task-toggle" data-id="${t.id}" aria-label="Toggle"></button>
        <div class="task-main">
          <span class="task-title">${safe}</span>
          ${t.done ? '<span class="task-tag task-tag-done">done</span>' : makeTagHtml(t.category)}
        </div>
        <button class="task-delete" data-delete-id="${t.id}" aria-label="Delete">✕</button>
      </li>`;
  }).join('');
}

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    tasks = await res.json();
    renderTasks();
  } catch (e) { console.error('loadTasks:', e); }
}

taskListEl.addEventListener('click', async e => {
  const toggleBtn = e.target.closest('[data-id]');
  if (toggleBtn) {
    attractToEdge(toggleBtn, 'left', 1200);
    const id = toggleBtn.dataset.id;
    try {
      const res  = await fetch(`/api/tasks/${id}`, { method: 'PATCH' });
      const data = await res.json();
      tasks = tasks.map(t => t.id === parseInt(id) ? data.task : t);
      updatePetUI(data.pet);
      renderTasks();
      if (data.task.done) {
        addNotif('task_done', `"${data.task.title}" completed`);
        react('task_done');
      } else {
        addNotif('task_undone', `"${data.task.title}" uncompleted`);
        react('idle');
      }
    } catch (e) {}
    return;
  }
  const deleteBtn = e.target.closest('[data-delete-id]');
  if (deleteBtn) {
    const id = deleteBtn.dataset.deleteId;
    const deletedTask = tasks.find(t => t.id === parseInt(id));
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      tasks = tasks.filter(t => t.id !== parseInt(id));
      renderTasks();
      if (deletedTask) addNotif('task_deleted', `"${deletedTask.title}" deleted`);
      react('task_deleted');
    } catch (e) {}
  }
});

taskForm.addEventListener('submit', async e => {
  e.preventDefault();
  const title = taskInput.value.trim();
  if (!title) return;
  try {
    const res  = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, category: selectedCategory })
    });
    const task = await res.json();
    tasks.unshift(task);
    renderTasks();
    addNotif('task_added', `"${title}" added · ${selectedCategory}`);
    closeModal();
    react('task_added');
    scheduleNextRest(600);
  } catch (e) {}
});

// ── Feed ──────────────────────────────────────────────────────────────────────
const feedBtn = document.getElementById('feedBtn');
feedBtn.addEventListener('click', async () => {
  attractToEdge(feedBtn, 'top', 1600);
  try {
    const res = await fetch('/api/feed', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'not enough coins');
      return;
    }
    const pet = await res.json();
    updatePetUI(pet);
    react('fed');
  } catch (e) {}
});

// ── Today count ───────────────────────────────────────────────────────────────
async function loadTodayCount() {
  try {
    const res  = await fetch('/api/stats/today');
    const data = await res.json();
    document.getElementById('todayCount').textContent = data.count;
  } catch (e) {}
}

// ── Content modal ─────────────────────────────────────────────────────────────
const contentModal      = document.getElementById('contentModal');
const contentForm       = document.getElementById('contentForm');
const contentInputEl    = document.getElementById('contentInput');
const contentTextareaEl = document.getElementById('contentTextarea');
const contentSelectEl   = document.getElementById('contentSelect');
let contentModalType    = null;

const CONTENT_CONFIGS = {
  focus:   { title:'log focus',      field:'text',     placeholder:'what did you focus on?',       select:['25 min','45 min','60 min','90 min'], apiPath:'/api/focus',   bodyKey:'label', extraKey:'duration' },
  habit:   { title:'build a habit',  field:'text',     placeholder:'what habit do you want to build?', select:['easy','medium','hard'],           apiPath:'/api/habits',  bodyKey:'title', extraKey:'difficulty' },
  journal: { title:'new entry',      field:'textarea', placeholder:'how are you feeling today?',   select:null,                                  apiPath:'/api/journal', bodyKey:'text'                         },
};

function openContentModal(type) {
  const cfg = CONTENT_CONFIGS[type];
  if (!cfg) return;
  contentModalType = type;
  document.getElementById('contentModalTitle').textContent = cfg.title;

  if (cfg.field === 'textarea') {
    contentInputEl.style.display    = 'none';
    contentTextareaEl.style.display = 'block';
    contentTextareaEl.placeholder   = cfg.placeholder;
    contentTextareaEl.value         = '';
  } else {
    contentInputEl.style.display    = 'block';
    contentTextareaEl.style.display = 'none';
    contentInputEl.placeholder      = cfg.placeholder;
    contentInputEl.value            = '';
  }

  if (cfg.select) {
    contentSelectEl.style.display = 'block';
    contentSelectEl.innerHTML     = cfg.select.map(o => `<option value="${o}">${o}</option>`).join('');
  } else {
    contentSelectEl.style.display = 'none';
  }

  contentModal.classList.remove('hidden');
  setTimeout(() => (cfg.field === 'textarea' ? contentTextareaEl : contentInputEl).focus(), 60);
}

function closeContentModal() {
  contentModal.classList.add('hidden');
  contentForm.reset();
  contentModalType = null;
}

document.getElementById('closeContentModal').addEventListener('click', closeContentModal);
document.getElementById('cancelContentModal').addEventListener('click', closeContentModal);
contentModal.addEventListener('click', e => { if (e.target === contentModal) closeContentModal(); });

contentForm.addEventListener('submit', async e => {
  e.preventDefault();
  const cfg = CONTENT_CONFIGS[contentModalType];
  if (!cfg) return;

  const text = (cfg.field === 'textarea' ? contentTextareaEl : contentInputEl).value.trim();
  if (!text) return;

  const body = { [cfg.bodyKey]: text };
  if (cfg.extraKey) body[cfg.extraKey] = contentSelectEl.value;

  try {
    await fetch(cfg.apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const savedType = contentModalType;
    closeContentModal();

    const notifTypeMap = { focus:'focus_added', goal:'goal_added', habit:'habit_added', journal:'journal_added' };
    const notifMsgMap  = {
      focus:   `focus session logged`,
      goal:    `goal "${text}" added`,
      habit:   `habit "${text}" added`,
      journal: `journal entry added`,
    };
    addNotif(notifTypeMap[savedType] || 'task_added', notifMsgMap[savedType] || text);

    const eventMap = { focus:'note_added', goal:'goal_set', habit:'note_added', journal:'journal_write' };
    react(eventMap[savedType] || 'note_added');

    if (savedType === 'focus')   loadFocus();
    if (savedType === 'goal')    loadGoals();
    if (savedType === 'habit')   loadHabits();
    if (savedType === 'journal') loadJournal();
  } catch(err) {}
});

// ── Pomodoro ──────────────────────────────────────────────────────────────────
const FOCUS_SETTINGS_KEY = 'blob_focus_settings';
const RING_CIRC = 2 * Math.PI * 88; // 552.92, matches r=88 in 200x200 SVG

function loadFocusSettings() {
  try { return Object.assign({ work: 25, short: 5, long: 15 }, JSON.parse(localStorage.getItem(FOCUS_SETTINGS_KEY) || '{}')); }
  catch { return { work: 25, short: 5, long: 15 }; }
}
function saveFocusSettings(s) { localStorage.setItem(FOCUS_SETTINGS_KEY, JSON.stringify(s)); }
let focusSettings = loadFocusSettings();

function getPomoDurations() {
  return { work: focusSettings.work * 60, short: focusSettings.short * 60, long: focusSettings.long * 60 };
}

let pomo = { active: false, paused: false, phase: 'work', remaining: 0, total: 0, count: 0, taskId: null, taskTitle: 'free focus', interval: null };
let focusSessions = [];

function pomoTimerText(sec) {
  return `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;
}

function updateRingGradient() {
  const fill = document.getElementById('focusRingFill');
  const glow = document.getElementById('focusRingGlow');
  if (!fill) return;
  // Use .style (inline) so it overrides the CSS presentation attribute
  if (pomo.phase === 'long_break') {
    fill.style.stroke = 'url(#ringGradLong)';
    if (glow) glow.className = 'focus-ring-glow break long';
  } else if (pomo.phase === 'short_break') {
    fill.style.stroke = 'url(#ringGradBreak)';
    if (glow) glow.className = 'focus-ring-glow break';
  } else {
    fill.style.stroke = 'url(#ringGradWork)';
    if (glow) glow.className = 'focus-ring-glow';
  }
}

function updateFocusUI() {
  const timerText    = document.getElementById('focusTimerText');
  const fill         = document.getElementById('focusRingFill');
  const phasePill    = document.getElementById('focusPhasePill');
  const sessionCount = document.getElementById('focusSessionCount');
  const taskName     = document.getElementById('focusTaskName');
  const dots         = document.getElementById('focusPomoDots');
  if (timerText) timerText.textContent = pomoTimerText(pomo.remaining);
  if (fill && pomo.total > 0) fill.style.strokeDashoffset = RING_CIRC * (1 - pomo.remaining / pomo.total);
  if (phasePill) {
    if (pomo.paused) { phasePill.textContent = 'PAUSED'; phasePill.className = 'focus-phase-pill paused'; }
    else if (pomo.phase === 'long_break')  { phasePill.textContent = 'LONG BREAK'; phasePill.className = 'focus-phase-pill long'; }
    else if (pomo.phase === 'short_break') { phasePill.textContent = 'BREAK'; phasePill.className = 'focus-phase-pill break'; }
    else { phasePill.textContent = 'WORK'; phasePill.className = 'focus-phase-pill'; }
  }
  const pauseBtn = document.getElementById('focusPauseBtn');
  if (pauseBtn) pauseBtn.textContent = pomo.paused ? 'resume' : 'pause';
  if (sessionCount) sessionCount.textContent = pomo.phase === 'work' ? `session ${pomo.count + 1} / 4` : `${pomo.count} / 4 done`;
  if (taskName) taskName.textContent = pomo.taskTitle;
  if (dots) dots.innerHTML = [0,1,2,3].map(i => `<div class="focus-pomo-dot ${i < pomo.count ? 'done' : ''}"></div>`).join('');
}

function showFocusActive() {
  document.getElementById('focusActive').classList.remove('hidden');
  document.getElementById('focusIdle').classList.add('hidden');
}

function showFocusIdle() {
  document.getElementById('focusActive').classList.add('hidden');
  document.getElementById('focusIdle').classList.remove('hidden');
}

function populateFocusTaskSelect() {
  const sel = document.getElementById('focusTaskSelect');
  if (!sel) return;
  const pending = tasks.filter(t => !t.done);
  sel.innerHTML = '<option value="">no specific task</option>' +
    pending.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
}

function updateDurUI() {
  const dw = document.getElementById('durWork');
  const ds = document.getElementById('durShort');
  const dl = document.getElementById('durLong');
  if (dw) dw.textContent = focusSettings.work;
  if (ds) ds.textContent = focusSettings.short;
  if (dl) dl.textContent = focusSettings.long;
}

function initFocusScreen() {
  if (pomo.active) {
    showFocusActive();
    updateFocusUI();
  } else {
    showFocusIdle();
    populateFocusTaskSelect();
    updateDurUI();
  }
  updateRingGradient();
  loadFocus();
}

function startPomodoro(taskId, taskTitle, settingsOverride) {
  if (pomo.interval) clearInterval(pomo.interval);
  if (settingsOverride) {
    if (settingsOverride.work)  focusSettings.work  = settingsOverride.work;
    if (settingsOverride.short) focusSettings.short = settingsOverride.short;
    if (settingsOverride.long)  focusSettings.long  = settingsOverride.long;
    saveFocusSettings(focusSettings);
  }
  const dur = getPomoDurations();
  pomo = { active: true, paused: false, phase: 'work', remaining: dur.work, total: dur.work, count: 0, taskId: taskId || null, taskTitle: taskTitle || 'free focus', interval: null };
  showFocusActive();
  updateFocusUI();
  updateRingGradient();
  pomo.interval = setInterval(tickPomodoro, 1000);
  react('goal_set');
  setTimeout(() => { closeChat(); showScreen('focus'); }, 250);
}

function pausePomodoro() {
  if (!pomo.active || pomo.paused) return;
  pomo.paused = true;
  updateFocusUI();
}

function resumePomodoro() {
  if (!pomo.active || !pomo.paused) return;
  pomo.paused = false;
  updateFocusUI();
}

function stopPomodoro() {
  if (pomo.interval) clearInterval(pomo.interval);
  const wasWork = pomo.phase === 'work';
  const elapsed = Math.round((pomo.total - pomo.remaining) / 60);
  pomo.active = false;
  pomo.interval = null;
  showFocusIdle();
  populateFocusTaskSelect();
  updateDurUI();
  if (wasWork && elapsed >= 1) {
    fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: pomo.taskTitle, duration: `${elapsed} min` }) }).then(() => loadFocus());
    addNotif('focus_added', `focus logged: "${pomo.taskTitle}" (${elapsed} min)`);
  } else {
    loadFocus();
  }
}

function tickPomodoro() {
  try {
    if (!pomo.active || pomo.paused) return;
    pomo.remaining = Math.max(0, pomo.remaining - 1);
    updateFocusUI();
    if (pomo.remaining === 0) advancePomodoro();
  } catch (e) {
    console.error('Pomodoro tick error:', e);
  }
}

function advancePomodoro() {
  const dur = getPomoDurations();
  if (pomo.phase === 'work') {
    pomo.count = Math.min(4, pomo.count + 1);
    fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: pomo.taskTitle, duration: `${focusSettings.work} min` }) }).then(() => loadFocus());
    addNotif('focus_added', `pomodoro done! "${pomo.taskTitle}"`);
    react('task_done');
    if (pomo.count >= 4) { pomo.phase = 'long_break'; pomo.remaining = pomo.total = dur.long; pomo.count = 0; say('great work! long break time.', 4000); }
    else { pomo.phase = 'short_break'; pomo.remaining = pomo.total = dur.short; say('nice! take a quick break.', 4000); }
  } else {
    pomo.phase = 'work'; pomo.remaining = pomo.total = dur.work;
    say("break's over! let's focus.", 4000);
    react('goal_set');
  }
  updateFocusUI();
  updateRingGradient();
}

document.getElementById('focusStartBtn').addEventListener('click', () => {
  const sel = document.getElementById('focusTaskSelect');
  const taskId = sel ? (parseInt(sel.value) || null) : null;
  const taskTitle = taskId ? (tasks.find(t => t.id === taskId) || {}).title || 'focus' : 'free focus';
  startPomodoro(taskId, taskTitle);
});

document.getElementById('focusPauseBtn').addEventListener('click', () => {
  if (!pomo.active) return;
  if (pomo.paused) resumePomodoro(); else pausePomodoro();
});

document.getElementById('focusSkipBtn').addEventListener('click', () => {
  if (!pomo.active) return;
  pomo.remaining = 0;
  advancePomodoro();
});

document.getElementById('focusStopBtn').addEventListener('click', () => {
  if (!pomo.active) return;
  stopPomodoro();
  react('idle');
});

document.querySelectorAll('.focus-dur-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const dur = btn.dataset.dur;
    const delta = parseInt(btn.dataset.delta);
    const limits = { work: [5, 90], short: [1, 30], long: [5, 60] };
    const [mn, mx] = limits[dur] || [1, 60];
    focusSettings[dur] = Math.min(mx, Math.max(mn, focusSettings[dur] + delta));
    saveFocusSettings(focusSettings);
    updateDurUI();
  });
});

// ── Focus ─────────────────────────────────────────────────────────────────────
async function loadFocus() {
  try {
    const res  = await fetch('/api/focus');
    const data = await res.json();
    focusSessions = data;
    const el   = document.getElementById('focusList');
    if (!data.length) { el.innerHTML = '<li class="empty-state">no sessions yet — start focusing!</li>'; return; }
    el.innerHTML = data.map(s => `
      <li class="item-card">
        <div class="item-card-top">
          <span class="item-card-text">${esc(s.label)}</span>
          <button class="item-card-delete" data-del-focus="${s.id}">✕</button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="item-card-label">${esc(s.duration)}</span>
          <span class="item-card-date">${fmtDate(s.created_at)}</span>
        </div>
      </li>`).join('');
  } catch(e) {}
}

document.getElementById('focusList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-del-focus]');
  if (!btn) return;
  await fetch(`/api/focus/${btn.dataset.delFocus}`, { method: 'DELETE' });
  loadFocus();
});

// ── Goals ─────────────────────────────────────────────────────────────────────
const GOAL_CATS = {
  fitness:  { color:'#f97316', icon: () => IC.bolt(12,'currentColor')   },
  academic: { color:'#a78bfa', icon: () => IC.sparkle(12,'currentColor') },
  financial:{ color:'#4ade80', icon: () => IC.trendUp(12,'currentColor') },
  personal: { color:'#ec4899', icon: () => IC.heartOut(12,'currentColor')},
  career:   { color:'#60a5fa', icon: () => IC.star(12,'currentColor')    },
  health:   { color:'#34d399', icon: () => IC.heart(12,'currentColor')   },
  social:   { color:'#fbbf24', icon: () => IC.people(12,'currentColor')  },
  creative: { color:'#f472b6', icon: () => IC.diamond(12,'currentColor') },
};
const DEFAULT_CAT = { color:'#a78bfa', icon: () => IC.sparkle(12,'currentColor') };

let expandedGoalId = null;
let chatGoals = [];

function goalDaysLeft(deadline) {
  if (!deadline) return null;
  const diff = Math.ceil((new Date(deadline) - new Date().setHours(0,0,0,0)) / 86400000);
  return diff;
}

function goalDaysHtml(deadline) {
  if (!deadline) return '';
  const d = goalDaysLeft(deadline);
  if (d < 0)  return `<span class="goal-days overdue">overdue</span>`;
  if (d === 0) return `<span class="goal-days today">due today</span>`;
  const cls = d <= 7 ? 'urgent' : d <= 30 ? 'soon' : 'fine';
  return `<span class="goal-days ${cls}">${d}d left</span>`;
}

function renderGoalCard(g) {
  const cat      = GOAL_CATS[g.category] || DEFAULT_CAT;
  const pct      = g.progress;
  const total    = g.milestone_total || 0;
  const done     = g.milestone_done  || 0;
  const expanded = expandedGoalId === g.id;
  const complete = pct >= 100;
  const today    = new Date().toISOString().slice(0,10);

  const milestonesHtml = g.milestones.map(m => `
    <li class="gm-item ${m.done ? 'done' : ''}">
      <button class="gm-check ${m.done ? 'checked' : ''}" data-ms-toggle="${g.id}" data-ms-id="${m.id}" data-ms-done="${m.done ? '1':'0'}">
        ${m.done ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </button>
      <span class="gm-text">${esc(m.text)}</span>
      <button class="gm-del" data-ms-del="${g.id}" data-ms-id="${m.id}">✕</button>
    </li>`).join('');

  const linkedHabitsHtml = g.linked_habits.map(h => {
    const doneToday = h.last_done && h.last_done.slice(0,10) === today;
    return `<div class="gl-habit-chip ${doneToday ? 'done' : ''}">
      ${doneToday ? IC.flame(11,'#4ade80') : IC.flame(11,'#f97316')}
      <span>${esc(h.title)}</span>
      <span class="gl-habit-streak">${h.streak}d</span>
      <button class="gl-unlink" data-unlink-habit="${g.id}" data-habit-id="${h.id}">✕</button>
    </div>`;
  }).join('');

  // Habit picker (habits not yet linked)
  const unlinkedHabits = chatHabits.filter(h => !g.linked_habits.find(lh => lh.id === h.id));
  const habitPickerHtml = unlinkedHabits.length ? `
    <select class="gl-habit-picker" data-link-habit="${g.id}">
      <option value="">+ link a habit</option>
      ${unlinkedHabits.map(h => `<option value="${h.id}">${esc(h.title)}</option>`).join('')}
    </select>` : '';

  return `<li class="goal-card ${complete ? 'complete' : ''} ${expanded ? 'expanded' : ''}" data-goal-id="${g.id}" style="--cat-color:${cat.color}">
    <div class="goal-card-header" data-expand-goal="${g.id}">
      <div class="goal-cat-row">
        <span class="goal-cat-icon" style="color:${cat.color}">${cat.icon()}</span>
        <span class="goal-cat-label" style="color:${cat.color}">${g.category}</span>
        ${goalDaysHtml(g.deadline)}
        <button class="goal-del-btn" data-del-goal="${g.id}">✕</button>
      </div>
      <div class="goal-title">${esc(g.title)}</div>
      <div class="goal-progress-wrap">
        <div class="goal-bar-track">
          <div class="goal-bar-fill" style="width:${pct}%;background:${cat.color}"></div>
        </div>
        <span class="goal-pct-label">${total > 0 ? `${done}/${total}` : `${pct}%`}</span>
        <svg class="goal-expand-arrow ${expanded ? 'open' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    ${expanded ? `
    <div class="goal-body">
      <div class="goal-section-label">
        milestones
        <button class="goal-add-ms-btn" data-add-ms="${g.id}">+ add</button>
      </div>
      <div class="goal-ms-add-wrap" id="msAddWrap_${g.id}" style="display:none">
        <input class="goal-ms-input" id="msInput_${g.id}" placeholder="add a milestone…" maxlength="80"/>
        <button class="goal-ms-save" data-save-ms="${g.id}">add</button>
      </div>
      <ul class="goal-ms-list">${milestonesHtml || '<li class="goal-ms-empty">no milestones yet</li>'}</ul>
      <div class="goal-section-label" style="margin-top:10px">
        linked habits
      </div>
      <div class="gl-habits-wrap">
        ${linkedHabitsHtml || '<span class="goal-ms-empty">no habits linked</span>'}
        ${habitPickerHtml}
      </div>
    </div>` : ''}
  </li>`;
}

async function loadGoals() {
  try {
    const res  = await fetch('/api/goals');
    const data = await res.json();
    chatGoals  = data;
    renderHomeGoal();
    const el   = document.getElementById('goalsList');
    if (!data.length) {
      el.innerHTML = '<li class="empty-state">no goals yet — set one!</li>';
      return;
    }
    el.innerHTML = data.map(renderGoalCard).join('');
  } catch(e) { console.error(e); }
}

document.getElementById('goalsList').addEventListener('click', async e => {
  // Delete goal
  const delBtn = e.target.closest('[data-del-goal]');
  if (delBtn) {
    await fetch(`/api/goals/${delBtn.dataset.delGoal}`, { method:'DELETE' });
    if (expandedGoalId === parseInt(delBtn.dataset.delGoal)) expandedGoalId = null;
    loadGoals(); return;
  }

  // Expand/collapse
  const expandEl = e.target.closest('[data-expand-goal]');
  if (expandEl && !e.target.closest('[data-del-goal]')) {
    const gid = parseInt(expandEl.dataset.expandGoal);
    expandedGoalId = expandedGoalId === gid ? null : gid;
    loadGoals(); return;
  }

  // Toggle milestone
  const msToggle = e.target.closest('[data-ms-toggle]');
  if (msToggle) {
    const gid  = msToggle.dataset.msToggle;
    const mid  = msToggle.dataset.msId;
    const done = msToggle.dataset.msDone !== '1';
    const res  = await fetch(`/api/goals/${gid}/milestones/${mid}`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ done })
    });
    const upd = await res.json();
    if (upd.progress >= 100) { addNotif('goal_progress', `"${upd.title}" — goal complete!`); react('goal_progress'); }
    loadGoals(); return;
  }

  // Delete milestone
  const msDel = e.target.closest('[data-ms-del]');
  if (msDel) {
    await fetch(`/api/goals/${msDel.dataset.msDel}/milestones/${msDel.dataset.msId}`, { method:'DELETE' });
    loadGoals(); return;
  }

  // Show add milestone input
  const addMsBtn = e.target.closest('[data-add-ms]');
  if (addMsBtn) {
    const wrap = document.getElementById(`msAddWrap_${addMsBtn.dataset.addMs}`);
    if (wrap) { wrap.style.display = wrap.style.display === 'none' ? 'flex' : 'none'; wrap.querySelector('input')?.focus(); }
    return;
  }

  // Save milestone
  const saveMsBtn = e.target.closest('[data-save-ms]');
  if (saveMsBtn) {
    const gid   = saveMsBtn.dataset.saveMs;
    const input = document.getElementById(`msInput_${gid}`);
    const text  = (input?.value || '').trim();
    if (!text) return;
    await fetch(`/api/goals/${gid}/milestones`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text })
    });
    loadGoals(); return;
  }

  // Unlink habit
  const unlinkBtn = e.target.closest('[data-unlink-habit]');
  if (unlinkBtn) {
    await fetch(`/api/goals/${unlinkBtn.dataset.unlinkHabit}/habits/${unlinkBtn.dataset.habitId}`, { method:'DELETE' });
    loadGoals(); return;
  }
});

// Milestone input enter key
document.getElementById('goalsList').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('.goal-ms-input');
  if (!input) return;
  const gid  = input.id.replace('msInput_', '');
  const text = input.value.trim();
  if (!text) return;
  await fetch(`/api/goals/${gid}/milestones`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ text })
  });
  loadGoals();
});

// Habit picker change → link habit
document.getElementById('goalsList').addEventListener('change', async e => {
  const picker = e.target.closest('[data-link-habit]');
  if (!picker || !picker.value) return;
  const gid = picker.dataset.linkHabit;
  const hid = picker.value;
  await fetch(`/api/goals/${gid}/habits`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ habit_id: parseInt(hid) })
  });
  loadGoals();
});

// Add goal form
document.getElementById('addGoalBtn').addEventListener('click', () => {
  const form = document.getElementById('addGoalForm');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) document.getElementById('goalTitleIn').focus();
});
document.getElementById('cancelGoalBtn').addEventListener('click', () => {
  document.getElementById('addGoalForm').classList.add('hidden');
});
document.getElementById('saveGoalBtn').addEventListener('click', async () => {
  const title    = document.getElementById('goalTitleIn').value.trim();
  const category = document.getElementById('goalCatIn').value;
  const deadline = document.getElementById('goalDeadlineIn').value || null;
  if (!title) return;
  await fetch('/api/goals', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title, category, deadline })
  });
  document.getElementById('goalTitleIn').value = '';
  document.getElementById('goalDeadlineIn').value = '';
  document.getElementById('addGoalForm').classList.add('hidden');
  addNotif('goal_added', `goal "${title}" added`);
  react('goal_set');
  loadGoals();
});

// ── Habits ────────────────────────────────────────────────────────────────────
const COIN_BY_DIFF = { easy: 1, medium: 3, hard: 5 };
const DIFF_COLOR   = { easy: 'diff-easy', medium: 'diff-medium', hard: 'diff-hard' };
const DAY_LABELS   = ['M','T','W','T','F','S','S'];

async function loadHabits() {
  try {
    const [habitsRes, streakRes] = await Promise.all([
      fetch('/api/habits'),
      fetch('/api/habits/streak'),
    ]);

    const habits = await habitsRes.json();
    const streak = await streakRes.json();
    chatHabits      = habits;
    lastHabitStreak = streak;
    renderHomeHabits();
    const el = document.getElementById('habitsList');
    const today  = new Date().toISOString().slice(0,10);

    const weekDots = DAY_LABELS.map((label, i) =>
      `<div class="habit-week-day">
        <span class="habit-week-label">${label}</span>
        <span class="habit-week-dot ${streak.week_done[i] ? 'filled' : ''}"></span>
      </div>`
    ).join('');

    const hasStreak = streak.habit_streak >= 7;

    const headerHtml = `<li class="habit-streak-header">
      <div class="habit-streak-top">
        <div class="habit-streak-left">
          <div class="habit-streak-icon">${IC.flame(22,'#f97316')}</div>
          <div>
            <div class="habit-streak-count">${streak.habit_streak} <span>day streak</span></div>
            <div class="habit-streak-longest">longest: ${streak.longest_habit_streak} days</div>
          </div>
        </div>
        <button class="freeze-token-btn" id="freezeTokenBtn">
          <span style="display:inline-flex;align-items:center;gap:4px;color:#93c5fd">${IC.snowflake(12,'currentColor')}</span> ${streak.freeze_tokens} freeze tokens
        </button>
      </div>
      <div class="habit-week-row">${weekDots}</div>
    </li>`;

    if (!habits.length) {
      el.innerHTML = headerHtml + '<li class="empty-state">no habits yet — build one!</li>';
      return;
    }

    const habitCards = habits.map(h => {
      const doneToday  = h.last_done && h.last_done.slice(0,10) === today;
      const paused     = !!h.paused;
      const coins      = COIN_BY_DIFF[h.difficulty] || 3;
      const fireIcon   = paused ? IC.flameSoft(13,'rgba(255,255,255,0.25)') : IC.flame(13,'#f97316');
      const streakTxt  = paused ? 'paused' : `${h.streak} day streak`;
      const diffClass  = DIFF_COLOR[h.difficulty] || 'diff-medium';
      const multiplierNote = h.streak >= 7 ? ' <span class="streak-bonus">1.5×</span>' : '';
      // show freeze button if streak > 0, not paused, not done today, and tokens available
      const canFreeze  = h.streak > 0 && !paused && !doneToday && streak.freeze_tokens > 0;
      return `<li class="item-card habit-card ${doneToday ? 'done-today' : ''} ${paused ? 'is-paused' : ''}">
        <div class="habit-card-main">
          <button class="habit-checkbox ${doneToday ? 'checked' : ''}" data-check-habit="${h.id}" data-done-today="${doneToday ? '1' : '0'}" ${paused ? 'disabled' : ''} aria-label="${doneToday ? 'Uncheck' : 'Check in'}">
            ${doneToday ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
          </button>
          <div class="habit-info">
            <div class="habit-title-row">
              <span class="habit-name">${esc(h.title)}</span>
              <span class="habit-diff-badge ${diffClass}">${h.difficulty}</span>
            </div>
            <div class="habit-meta">
              <span class="habit-streak-text">${streakTxt}</span>
              <span class="habit-fire">${fireIcon}</span>
            </div>
          </div>
          <div class="habit-right">
            <div class="habit-coins">
              <span class="coin-icon" style="color:#fbbf24">${IC.coin(13,'currentColor')}</span>${coins}${multiplierNote}
            </div>
            <div class="habit-actions">
              ${canFreeze ? `<button class="habit-freeze-btn" data-freeze-habit="${h.id}" title="use freeze token">${IC.snowflake(11,'currentColor')}</button>` : ''}
              <button class="habit-pause-btn" data-pause-habit="${h.id}" title="${paused ? 'resume' : 'pause'}">
                ${paused ? IC.play(11,'currentColor') : IC.pause(11,'currentColor')}
              </button>
              <button class="item-card-delete" data-del-habit="${h.id}">✕</button>
            </div>
          </div>
        </div>
      </li>`;
    }).join('');

    const bonusBadge = `<li class="habit-bonus-badge">
      <span>⚡ 7+ day streak = 1.5× coins</span>
    </li>`;

    el.innerHTML = headerHtml + habitCards + bonusBadge;
  } catch(e) { console.error(e); }
}

document.getElementById('habitsList').addEventListener('click', async e => {
  const delBtn = e.target.closest('[data-del-habit]');
  if (delBtn) {
    await fetch(`/api/habits/${delBtn.dataset.delHabit}`, { method:'DELETE' });
    loadHabits();
    return;
  }

  const checkBtn = e.target.closest('[data-check-habit]');
  if (checkBtn && !checkBtn.disabled) {
    const doneToday = checkBtn.dataset.doneToday === '1';
    if (doneToday) {
      const res  = await fetch(`/api/habits/${checkBtn.dataset.checkHabit}/uncheck`, { method:'POST' });
      const data = await res.json();
      if (data.habit) {
        addNotif('habit_checked', `"${data.habit.title}" unchecked`);
        if (data.pet) updatePetUI(data.pet);
      }
    } else {
      const res  = await fetch(`/api/habits/${checkBtn.dataset.checkHabit}/check`, { method:'POST' });
      const data = await res.json();
      if (data.habit) {
        addNotif('habit_checked', `"${data.habit.title}" checked in · ${data.habit.streak} day streak`);
        if (data.pet) updatePetUI(data.pet);
      }
      react('habit_checked');
    }
    loadHabits();
    return;
  }

  const pauseBtn = e.target.closest('[data-pause-habit]');
  if (pauseBtn) {
    await fetch(`/api/habits/${pauseBtn.dataset.pauseHabit}/pause`, { method:'POST' });
    loadHabits();
    return;
  }

  const freezeBtn = e.target.closest('[data-freeze-habit]');
  if (freezeBtn) {
    const res  = await fetch(`/api/habits/${freezeBtn.dataset.freezeHabit}/freeze`, { method:'POST' });
    const data = await res.json();
    if (data.error) { showToast(data.error); return; }
    showToast('❄ streak frozen! token used');
    if (data.pet) updatePetUI(data.pet);
    loadHabits();
    return;
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────
let navData = null;
let navTab  = 'overview';

function radarSVG(areas) {
  const cx = 105, cy = 105, maxR = 72;
  const N = areas.length;
  const step = (2 * Math.PI) / N;
  const start = -Math.PI / 2;
  const pt = (i, r) => {
    const a = start + i * step;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const gridLines = [0.33, 0.66, 1].map(lvl => {
    const pts = areas.map((_, i) => pt(i, maxR * lvl).join(',')).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
  }).join('');
  const axes = areas.map((_, i) => {
    const [x, y] = pt(i, maxR);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
  }).join('');
  const dataPts = areas.map((a, i) => pt(i, maxR * a.score / 100).map(v => v.toFixed(1)).join(',')).join(' ');
  const dataShape = `<polygon points="${dataPts}" fill="rgba(124,58,237,0.22)" stroke="#7c3aed" stroke-width="2"/>`;
  const dots = areas.map((a, i) => {
    const [dx, dy] = pt(i, maxR * a.score / 100);
    return `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="3.5" fill="#7c3aed"/>`;
  }).join('');
  const labels = areas.map((a, i) => {
    const [lx, ly] = pt(i, maxR + 16);
    return `<text x="${lx.toFixed(1)}" y="${(ly - 3).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="rgba(255,255,255,0.55)" font-family="Inter,sans-serif">${a.area}</text>
            <text x="${lx.toFixed(1)}" y="${(ly + 8).toFixed(1)}" text-anchor="middle" font-size="8" fill="#a78bfa" font-family="Inter,sans-serif">${a.score}%</text>`;
  }).join('');
  return `<svg viewBox="0 0 210 210" xmlns="http://www.w3.org/2000/svg" class="radar-svg">${gridLines}${axes}${dataShape}${dots}${labels}</svg>`;
}

function renderNavOverview(d) {
  const id = d.identity;
  const sa = parseInt(id.self_awareness) || 0;
  const co = parseInt(id.consistency) || 0;
  const gm = parseInt(id.growth_mindset) || 0;
  const overviewCard = `
    <div class="nav-card nav-self-overview">
      <div class="nav-self-top">
        <div>
          <div class="nav-self-title">self overview</div>
          <div class="nav-self-sub">you're on a journey of growth.</div>
        </div>
      </div>
      <div class="nav-score-row">
        <span class="nav-score-icon" style="color:#a78bfa">${IC.heartOut(14,'currentColor')}</span>
        <div class="nav-score-info">
          <span class="nav-score-label">self awareness</span>
          <div class="nav-score-bar"><div class="nav-score-fill" style="width:${sa}%;background:linear-gradient(90deg,#7c3aed,#a78bfa)"></div></div>
        </div>
        <span class="nav-score-pct">${sa}%</span>
      </div>
      <div class="nav-score-row">
        <span class="nav-score-icon" style="color:#fbbf24">${IC.star(14,'currentColor')}</span>
        <div class="nav-score-info">
          <span class="nav-score-label">consistency</span>
          <div class="nav-score-bar"><div class="nav-score-fill" style="width:${co}%;background:linear-gradient(90deg,#d97706,#fbbf24)"></div></div>
        </div>
        <span class="nav-score-pct">${co}%</span>
      </div>
      <div class="nav-score-row">
        <span class="nav-score-icon" style="color:#f472b6">${IC.trendUp(14,'currentColor')}</span>
        <div class="nav-score-info">
          <span class="nav-score-label">growth</span>
          <div class="nav-score-bar"><div class="nav-score-fill" style="width:${gm}%;background:linear-gradient(90deg,#db2777,#f472b6)"></div></div>
        </div>
        <span class="nav-score-pct">${gm}%</span>
      </div>
    </div>`;

  const areaOrder = ['mental','physical','social','spiritual','financial','emotional'];
  const areaIcons = {
    mental:   IC.brain(13,'currentColor'),
    emotional:IC.heart(13,'currentColor'),
    physical: IC.bolt(13,'currentColor'),
    social:   IC.people(13,'currentColor'),
    spiritual:IC.sparkle(13,'currentColor'),
    financial:IC.trendUp(13,'currentColor'),
  };
  const areaColors = { mental:'#7c3aed', emotional:'#ec4899', physical:'#d97706', social:'#d97706', spiritual:'#7c3aed', financial:'#ec4899' };
  const ordered = areaOrder.map(name => d.areas.find(a => a.area === name)).filter(Boolean);

  const radarSection = `
    <div class="nav-card">
      <div class="nav-card-title">your life areas</div>
      <div class="nav-card-sub">explore what matters most.</div>
      <div class="nav-radar-wrap">${radarSVG(ordered)}</div>
      <div class="nav-area-list">
        ${d.areas.map(a => `
          <div class="nav-area-row">
            <span class="nav-area-icon">${areaIcons[a.area] || '✦'}</span>
            <span class="nav-area-name">${a.area}</span>
            <div class="nav-area-bar-wrap">
              <div class="nav-area-bar-fill" style="width:${a.score}%;background:${areaColors[a.area]||'#7c3aed'}"></div>
            </div>
            <span class="nav-area-pct">${a.score}%</span>
            <input type="range" min="0" max="100" value="${a.score}" class="nav-area-slider" data-area="${a.area}" title="adjust ${a.area}">
          </div>`).join('')}
      </div>
    </div>`;

  const insight = d.identity.insight || '';
  const lastAnalyzed = d.identity.last_analyzed ? new Date(d.identity.last_analyzed).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : null;
  const insightCard = insight ? `
    <div class="nav-card nav-insight-card">
      <div class="nav-insight-header">
        <span class="nav-insight-label"><span style="display:inline-flex;align-items:center;gap:4px;vertical-align:middle">${IC.sparkle(11,'currentColor')}</span> ai insight</span>
        <button class="nav-reanalyze-btn" id="reAnalyzeBtn" title="re-analyze"><span style="display:inline-flex;align-items:center;gap:3px">${IC.refresh(11,'currentColor')} ${lastAnalyzed || 're-analyze'}</span></button>
      </div>
      <div class="nav-insight-text">${esc(insight)}</div>
    </div>` : `<button class="nav-add-btn" id="reAnalyzeBtn" style="margin-bottom:4px">✦ analyze with AI</button>`;

  document.getElementById('navTabContent').innerHTML = insightCard + overviewCard + radarSection;
}

function renderNavFuture(d) {
  const primary = d.careers.find(c => c.is_primary) || d.careers[0];
  const others  = d.careers.filter(c => !c.is_primary);
  const levelBadge = lvl => {
    const cls = { high:'lvl-high', 'very high':'lvl-very-high', medium:'lvl-medium', low:'lvl-low' };
    return `<span class="nav-lvl-badge ${cls[lvl]||'lvl-medium'}">${lvl}</span>`;
  };

  const primaryCard = primary ? `
    <div class="nav-career-primary">
      <div class="nav-career-primary-top">
        <span class="nav-career-primary-title">${esc(primary.title)}</span>
        <span class="nav-career-badge-primary">primary path</span>
      </div>
      <div class="nav-career-stat"><span>alignment</span><div class="nav-area-bar-wrap" style="flex:1;margin:0 8px"><div class="nav-area-bar-fill" style="width:${primary.alignment}%;background:#7c3aed"></div></div><span style="color:#a78bfa;font-size:0.78rem">${primary.alignment}%</span></div>
      <div class="nav-career-stat"><span>earning potential</span>${levelBadge(primary.earning)}</div>
      <div class="nav-career-stat"><span>fulfillment</span>${levelBadge(primary.fulfillment)}</div>
      <div class="nav-career-stat"><span>growth potential</span>${levelBadge(primary.growth_potential)}</div>
      <button class="nav-explore-btn" data-del-career="${primary.id}">remove path ✕</button>
    </div>` : '<div class="empty-state">no primary path yet</div>';

  const otherCards = others.map(c => `
    <div class="nav-career-alt">
      <span class="nav-career-alt-title">${esc(c.title)}</span>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
        <span class="nav-career-alt-pct">${c.alignment}%</span>
        <button class="nav-set-primary-btn" data-primary-career="${c.id}" title="set as primary">★</button>
        <button class="item-card-delete" data-del-career="${c.id}">✕</button>
      </div>
    </div>`).join('');

  const addCareerForm = `
    <div class="nav-add-form" id="addCareerForm" style="display:none">
      <input id="careerTitleInput" class="nav-input" placeholder="career title" maxlength="60"/>
      <div class="nav-form-row">
        <label>alignment %</label>
        <input id="careerAlignInput" class="nav-input" type="number" min="0" max="100" value="60" style="width:70px"/>
      </div>
      <div class="nav-form-row">
        <label>earning</label>
        <select id="careerEarnSelect" class="nav-select"><option>high</option><option selected>medium</option><option>low</option></select>
      </div>
      <div class="nav-form-row">
        <label>fulfillment</label>
        <select id="careerFulfillSelect" class="nav-select"><option>high</option><option selected>medium</option><option>low</option></select>
      </div>
      <div class="nav-form-row">
        <label>growth</label>
        <select id="careerGrowthSelect" class="nav-select"><option>very high</option><option>high</option><option selected>medium</option><option>low</option></select>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="nav-save-btn" id="saveCareerBtn">add path</button>
        <button class="nav-cancel-btn" id="cancelCareerBtn">cancel</button>
      </div>
    </div>`;

  const passionStrengthColors = { strong:'#7c3aed', medium:'#d97706', weak:'#6b7280' };
  const passionCards = d.passions.map(p => `
    <div class="nav-passion-tag" style="border-color:${passionStrengthColors[p.strength]||'#7c3aed'}22">
      <span class="nav-passion-icon" style="color:${passionStrengthColors[p.strength]||'#7c3aed'}">✦</span>
      <span class="nav-passion-title">${esc(p.title)}</span>
      <span class="nav-passion-strength" style="color:${passionStrengthColors[p.strength]||'#7c3aed'}">${p.strength}</span>
      <button class="item-card-delete" data-del-passion="${p.id}">✕</button>
    </div>`).join('');

  const addPassionForm = `
    <div class="nav-add-form" id="addPassionForm" style="display:none">
      <input id="passionTitleInput" class="nav-input" placeholder="passion or interest" maxlength="60"/>
      <div class="nav-form-row">
        <label>strength</label>
        <select id="passionStrengthSelect" class="nav-select"><option>strong</option><option selected>medium</option><option>weak</option></select>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="nav-save-btn" id="savePassionBtn">add</button>
        <button class="nav-cancel-btn" id="cancelPassionBtn">cancel</button>
      </div>
    </div>`;

  document.getElementById('navTabContent').innerHTML = `
    <div class="nav-card">
      <div class="nav-card-title">career path</div>
      <div class="nav-card-sub">explore your ideal future.</div>
      ${primaryCard}
      ${others.length ? `<div class="nav-career-alts">${otherCards}</div>` : ''}
      ${addCareerForm}
      <button class="nav-add-btn" id="showAddCareerBtn">+ add custom path</button>
    </div>
    <div class="nav-card">
      <div class="nav-card-title">passions & interests</div>
      <div class="nav-card-sub">what lights you up.</div>
      <div class="nav-passions-list">${passionCards || '<div class="empty-state">no passions yet</div>'}</div>
      ${addPassionForm}
      <button class="nav-add-btn" id="showAddPassionBtn">+ add passion</button>
    </div>`;
}

function renderNavIdentity(d) {
  const id = d.identity;
  const fields = [
    { key:'core_values',      label:'core values',      icon:'💜', hint:'e.g. growth, creativity, kindness' },
    { key:'personality_type', label:'personality type', icon:'🔮', hint:'e.g. introspective · curious' },
    { key:'energy_pattern',   label:'energy pattern',   icon:'⚡', hint:'e.g. most active in the morning' },
    { key:'love_language',    label:'love language',    icon:'🤍', hint:'e.g. words of affirmation' },
  ];
  const scoreFields = [
    { key:'self_awareness', label:'self awareness %', min:0, max:100 },
    { key:'consistency',    label:'consistency %',    min:0, max:100 },
    { key:'growth_mindset', label:'growth mindset %', min:0, max:100 },
  ];
  const fieldCards = fields.map(f => `
    <div class="nav-identity-row">
      <span class="nav-identity-icon">${f.icon}</span>
      <div class="nav-identity-body">
        <div class="nav-identity-label">${f.label}</div>
        <div class="nav-identity-value" contenteditable="true" data-id-key="${f.key}" spellcheck="false">${esc(id[f.key] || '')}</div>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`).join('');
  const scoreCards = scoreFields.map(f => `
    <div class="nav-score-edit-row">
      <span class="nav-score-edit-label">${f.label}</span>
      <input type="range" min="${f.min}" max="${f.max}" value="${parseInt(id[f.key])||0}" class="nav-score-slider" data-id-key="${f.key}">
      <span class="nav-score-edit-val" id="nav-score-val-${f.key}">${parseInt(id[f.key])||0}%</span>
    </div>`).join('');

  document.getElementById('navTabContent').innerHTML = `
    <div class="nav-card">
      <div class="nav-card-title">identity snapshot</div>
      <div class="nav-card-sub">tap any field to edit.</div>
      <div class="nav-identity-list">${fieldCards}</div>
    </div>
    <div class="nav-card">
      <div class="nav-card-title">your scores</div>
      <div class="nav-card-sub">drag to update.</div>
      <div class="nav-score-edit-list">${scoreCards}</div>
    </div>`;
}

const NAV_LOADING_MSGS = [
  'reading your activity patterns…',
  'analyzing your habits & streaks…',
  'mapping your life areas…',
  'discovering your passions…',
  'plotting your career paths…',
  'crafting your identity snapshot…',
  'almost done…',
];

function showNavLoading() {
  const content = document.getElementById('navTabContent');
  const tabs    = document.getElementById('navTabs');
  tabs.style.display = 'none';
  let msgIdx = 0;
  content.innerHTML = `
    <div class="nav-loading">
      <div class="nav-loading-blob">
        <div class="nav-loading-glow"></div>
        <div class="nav-loading-emoji">${IC.sparkle(36,'#a78bfa')}</div>
      </div>
      <div class="nav-loading-title">analyzing your journey</div>
      <div class="nav-loading-msg" id="navLoadingMsg">${NAV_LOADING_MSGS[0]}</div>
      <div class="nav-loading-dots"><span></span><span></span><span></span></div>
    </div>`;
  const msgEl = document.getElementById('navLoadingMsg');
  const interval = setInterval(() => {
    msgIdx = (msgIdx + 1) % NAV_LOADING_MSGS.length;
    if (msgEl) msgEl.textContent = NAV_LOADING_MSGS[msgIdx];
  }, 1800);
  return interval;
}

async function loadNavigation() {
  try {
    const res = await fetch('/api/navigation');
    navData = await res.json();
    const analyzed = navData.identity && navData.identity.last_analyzed;
    if (!analyzed) {
      // First time — run AI analysis
      const interval = showNavLoading();
      try {
        const analyzeRes = await fetch('/api/navigation/analyze', { method: 'POST' });
        navData = await analyzeRes.json();
      } catch(e) { console.error('analyze failed', e); }
      clearInterval(interval);
      document.getElementById('navTabs').style.display = '';
    }
    renderNavTab();
  } catch(e) { console.error(e); }
}

async function reAnalyzeNavigation() {
  const interval = showNavLoading();
  try {
    const res = await fetch('/api/navigation/analyze', { method: 'POST' });
    navData   = await res.json();
  } catch(e) { console.error(e); }
  clearInterval(interval);
  document.getElementById('navTabs').style.display = '';
  renderNavTab();
}

function renderNavTab() {
  if (!navData) return;
  if (navTab === 'overview')  renderNavOverview(navData);
  else if (navTab === 'future')   renderNavFuture(navData);
  else if (navTab === 'identity') renderNavIdentity(navData);
  bindNavEvents();
}

function bindNavEvents() {
  // Re-analyze button
  const reBtn = document.getElementById('reAnalyzeBtn');
  if (reBtn) reBtn.addEventListener('click', reAnalyzeNavigation);

  // Life area sliders (overview tab)
  document.querySelectorAll('.nav-area-slider').forEach(slider => {
    slider.addEventListener('input', e => {
      const area = e.target.dataset.area;
      const score = parseInt(e.target.value);
      const row = e.target.closest('.nav-area-row');
      if (row) {
        row.querySelector('.nav-area-bar-fill').style.width = score + '%';
        row.querySelector('.nav-area-pct').textContent = score + '%';
      }
    });
    slider.addEventListener('change', async e => {
      const area = e.target.dataset.area;
      const score = parseInt(e.target.value);
      await fetch('/api/navigation/life-areas', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ area, score })
      });
      // update local data + redraw radar
      const found = navData.areas.find(a => a.area === area);
      if (found) found.score = score;
      const areaOrder = ['mental','physical','social','spiritual','financial','emotional'];
      const ordered = areaOrder.map(name => navData.areas.find(a => a.area === name)).filter(Boolean);
      const wrap = document.querySelector('.nav-radar-wrap');
      if (wrap) wrap.innerHTML = radarSVG(ordered);
    });
  });

  // Identity contenteditable fields
  document.querySelectorAll('[data-id-key]').forEach(el => {
    if (el.tagName === 'DIV') {
      el.addEventListener('blur', async () => {
        const key   = el.dataset.idKey;
        const value = el.textContent.trim();
        await fetch('/api/navigation/identity', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value })
        });
        if (navData.identity) navData.identity[key] = value;
      });
    }
  });

  // Score sliders (identity tab)
  document.querySelectorAll('.nav-score-slider').forEach(slider => {
    slider.addEventListener('input', e => {
      const key = e.target.dataset.idKey;
      const val = document.getElementById(`nav-score-val-${key}`);
      if (val) val.textContent = e.target.value + '%';
    });
    slider.addEventListener('change', async e => {
      const key   = e.target.dataset.idKey;
      const value = e.target.value;
      await fetch('/api/navigation/identity', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      });
      if (navData.identity) navData.identity[key] = value;
    });
  });

  // Future tab — show/hide add career form
  const showCareerBtn  = document.getElementById('showAddCareerBtn');
  const addCareerForm  = document.getElementById('addCareerForm');
  const saveCareerBtn  = document.getElementById('saveCareerBtn');
  const cancelCareerBtn = document.getElementById('cancelCareerBtn');
  if (showCareerBtn) {
    showCareerBtn.addEventListener('click', () => {
      addCareerForm.style.display = 'block';
      showCareerBtn.style.display = 'none';
    });
  }
  if (cancelCareerBtn) cancelCareerBtn.addEventListener('click', () => {
    addCareerForm.style.display = 'none';
    showCareerBtn.style.display = '';
  });
  if (saveCareerBtn) saveCareerBtn.addEventListener('click', async () => {
    const title = document.getElementById('careerTitleInput').value.trim();
    if (!title) return;
    await fetch('/api/navigation/career-paths', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        alignment:       parseInt(document.getElementById('careerAlignInput').value) || 50,
        earning:         document.getElementById('careerEarnSelect').value,
        fulfillment:     document.getElementById('careerFulfillSelect').value,
        growth_potential: document.getElementById('careerGrowthSelect').value,
      })
    });
    await loadNavigation();
    navTab = 'future';
    renderNavTab();
  });

  // Future tab — show/hide add passion form
  const showPassionBtn  = document.getElementById('showAddPassionBtn');
  const addPassionForm  = document.getElementById('addPassionForm');
  const savePassionBtn  = document.getElementById('savePassionBtn');
  const cancelPassionBtn = document.getElementById('cancelPassionBtn');
  if (showPassionBtn) {
    showPassionBtn.addEventListener('click', () => {
      addPassionForm.style.display = 'block';
      showPassionBtn.style.display = 'none';
    });
  }
  if (cancelPassionBtn) cancelPassionBtn.addEventListener('click', () => {
    addPassionForm.style.display = 'none';
    showPassionBtn.style.display = '';
  });
  if (savePassionBtn) savePassionBtn.addEventListener('click', async () => {
    const title    = document.getElementById('passionTitleInput').value.trim();
    const strength = document.getElementById('passionStrengthSelect').value;
    if (!title) return;
    await fetch('/api/navigation/passions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, strength })
    });
    await loadNavigation();
    navTab = 'future';
    renderNavTab();
  });

  // Delete / primary career
  document.querySelectorAll('[data-del-career]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/navigation/career-paths/${btn.dataset.delCareer}`, { method:'DELETE' });
      await loadNavigation(); renderNavTab();
    });
  });
  document.querySelectorAll('[data-primary-career]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/navigation/career-paths/${btn.dataset.primaryCareer}/primary`, { method:'POST' });
      await loadNavigation(); renderNavTab();
    });
  });

  // Delete passion
  document.querySelectorAll('[data-del-passion]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/navigation/passions/${btn.dataset.delPassion}`, { method:'DELETE' });
      await loadNavigation(); renderNavTab();
    });
  });
}

// Tab switching
document.getElementById('navTabs').addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  navTab = tab.dataset.tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === navTab));
  renderNavTab();
});

// ── Journal ───────────────────────────────────────────────────────────────────
async function loadJournal() {
  try {
    const res  = await fetch('/api/journal');
    const data = await res.json();
    const el   = document.getElementById('journalList');
    if (!data.length) { el.innerHTML = '<li class="empty-state">no entries yet — how are you feeling?</li>'; return; }
    el.innerHTML = data.map(j => `
      <li class="item-card">
        <div class="item-card-top">
          <span class="item-card-text">${esc(j.text)}</span>
          <button class="item-card-delete" data-del-journal="${j.id}">✕</button>
        </div>
        <span class="item-card-date" style="margin-top:2px;">${fmtDate(j.created_at)}</span>
      </li>`).join('');
  } catch(e) {}
}

document.getElementById('journalList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-del-journal]');
  if (!btn) return;
  await fetch(`/api/journal/${btn.dataset.delJournal}`, { method:'DELETE' });
  loadJournal();
});

// ── Chat ──────────────────────────────────────────────────────────────────────
const chatPanel    = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatInput    = document.getElementById('chatInput');
const chatSendBtn  = document.getElementById('chatSendBtn');
let chatHistory = [];

// ── Persistent display history (localStorage) ─────────────────────────────
const CHAT_DISPLAY_KEY = 'blob_chat_display';
let chatInitialized = false;

function loadChatDisplay() {
  try { return JSON.parse(localStorage.getItem(CHAT_DISPLAY_KEY) || '[]'); }
  catch { return []; }
}
function saveDisplayMsg(role, text, time) {
  const hist = loadChatDisplay();
  hist.push({ role, text, time });
  localStorage.setItem(CHAT_DISPLAY_KEY, JSON.stringify(hist.slice(-150)));
}

// ── Reply-to state ─────────────────────────────────────────────────────────
const chatReplyBar   = document.getElementById('chatReplyBar');
const chatReplyText  = document.getElementById('chatReplyText');
const chatReplyClear = document.getElementById('chatReplyClear');
let replyContext = null;

function setReply(text, role) {
  replyContext = { text, role };
  chatReplyText.textContent = text.length > 65 ? text.slice(0, 65) + '…' : text;
  chatReplyBar.classList.add('visible');
  chatInput.focus();
}
function clearReply() {
  replyContext = null;
  chatReplyBar.classList.remove('visible');
}
chatReplyClear.addEventListener('click', clearReply);

const CHAT_GREETINGS = {
  terrified: '...um... h-hi...',
  shy:       'oh! hi... you came to talk?',
  cautious:  'hey! oh, you want to chat?',
  friendly:  'hi!! so happy you stopped by!',
  bonded:    'YOU CLICKED ME!! hi hi hi!!',
};

function appendSessionBreak() {
  const el = document.createElement('div');
  el.className = 'chat-session-break';
  const d = new Date();
  const label = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  el.innerHTML = `<span>new session · ${label}</span>`;
  chatMessages.appendChild(el);
}

function openChat() {
  chatPanel.classList.add('open');
  const t = tier();
  const tierEl = document.getElementById('chatTier');
  tierEl.textContent = t;
  tierEl.className = `chat-tier tier-${t}`;

  if (!chatInitialized) {
    chatInitialized = true;
    const oldHistory = loadChatDisplay();
    if (oldHistory.length) {
      oldHistory.forEach(m => {
        const el = makeBubbleEl(m.text, m.role === 'user' ? 'user' : 'blob', m.time);
        el.classList.add('old-session');
        chatMessages.appendChild(el);
      });
      appendSessionBreak();
    }
    appendBlobBubble(CHAT_GREETINGS[t] || 'hi!');
  }

  setTimeout(() => { chatInput.focus(); scrollChatToBottom(); }, 340);
  localStats.familiarity = clampStat(localStats.familiarity + 1);
  saveLocalStats();
  refreshMood();
}

function closeChat() {
  chatPanel.classList.remove('open');
  chatInput.blur();
}

function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

const COPY_SVG  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const TRASH_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
const REPLY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`;

function makeBubbleEl(text, type, time = null, replyTo = null) {
  const wrap = document.createElement('div');
  wrap.className = `chat-bubble ${type}-bubble`;

  if (replyTo) {
    const quoteEl = document.createElement('div');
    quoteEl.className = 'bubble-reply-quote';
    quoteEl.textContent = replyTo.text.length > 60 ? replyTo.text.slice(0, 60) + '…' : replyTo.text;
    wrap.appendChild(quoteEl);
  }

  const textEl = document.createElement('div');
  textEl.className = 'bubble-text';
  textEl.textContent = text;

  const footer = document.createElement('div');
  footer.className = 'bubble-footer';

  const timeEl = document.createElement('span');
  timeEl.className = 'bubble-time';
  timeEl.textContent = time || fmtTime();

  const actions = document.createElement('div');
  actions.className = 'bubble-actions';

  const replyBtn = document.createElement('button');
  replyBtn.className = 'bubble-action-btn bubble-reply';
  replyBtn.title = 'Reply';
  replyBtn.innerHTML = REPLY_SVG;
  replyBtn.addEventListener('click', () => setReply(text, type === 'user' ? 'user' : 'blob'));

  const copyBtn = document.createElement('button');
  copyBtn.className = 'bubble-action-btn bubble-copy';
  copyBtn.title = 'Copy';
  copyBtn.dataset.copyText = text;
  copyBtn.innerHTML = COPY_SVG;

  const delBtn = document.createElement('button');
  delBtn.className = 'bubble-action-btn bubble-delete';
  delBtn.title = 'Delete';
  delBtn.innerHTML = TRASH_SVG;

  actions.appendChild(replyBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(delBtn);
  footer.appendChild(timeEl);
  footer.appendChild(actions);
  wrap.appendChild(textEl);
  wrap.appendChild(footer);
  return wrap;
}

function appendBlobBubble(text, thinking = false) {
  let el;
  if (thinking) {
    el = document.createElement('div');
    el.className = 'chat-bubble blob-bubble thinking';
    el.textContent = text;
  } else {
    const t = fmtTime();
    el = makeBubbleEl(text, 'blob', t);
    saveDisplayMsg('blob', text, t);
  }
  chatMessages.appendChild(el);
  scrollChatToBottom();
  return el;
}

function appendUserBubble(text, replyTo = null) {
  const t = fmtTime();
  const el = makeBubbleEl(text, 'user', t, replyTo);
  chatMessages.appendChild(el);
  scrollChatToBottom();
  saveDisplayMsg('user', text, t);
}

const DONE_VOICES = {
  terrified: ['d-done...!', 'o-okay... done', 'f-finished...', '...did it'],
  shy:       ['done! :)', 'all set!', 'finished!', 'okay, done'],
  cautious:  ['all done!', 'got it done!', 'finished up!', 'done and dusted'],
  friendly:  ['done!! yayyy!', 'all done!! 🎉', 'finished!! nice!', 'yay, did it!!'],
  bonded:    ['DONE!! i did it!!', 'YESSS!! all done!!', 'GOT IT!! done done done!!', 'FINISHED!! woo!!'],
};

// Per-action-type visual metadata
const ACTION_META = {
  create_task:   { color: '#4ade80', label: 'Add task',      icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>` },
  delete_task:   { color: '#f87171', label: 'Delete task',   icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>` },
  complete_task: { color: '#a78bfa', label: 'Complete task', icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` },
  update_task:   { color: '#60a5fa', label: 'Update task',   icon: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` },
};

function showActionCard(actions) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-bubble blob-bubble action-card-wrap';

  // Action rows
  const rows = document.createElement('div');
  rows.className = 'action-rows';
  actions.forEach(a => {
    const meta = ACTION_META[a.name] || { color: '#666', label: a.name, icon: '' };
    const row = document.createElement('div');
    row.className = 'action-row';
    row.innerHTML = `
      <span class="action-row-icon" style="color:${meta.color}">${meta.icon}</span>
      <div class="action-row-body">
        <span class="action-row-type" style="color:${meta.color}">${meta.label}</span>
        <span class="action-row-label">${esc(a.label.replace(/^(add|delete|complete|uncomplete|update)\s+/i, '').replace(/^"(.+)".*/, '$1'))}</span>
      </div>`;
    rows.appendChild(row);
  });

  const btns = document.createElement('div');
  btns.className = 'action-card-btns';

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'action-btn accept';
  acceptBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> confirm`;

  const declineBtn = document.createElement('button');
  declineBtn.className = 'action-btn decline';
  declineBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> cancel`;

  acceptBtn.addEventListener('click', async () => {
    acceptBtn.disabled = true;
    declineBtn.disabled = true;
    acceptBtn.textContent = '...';
    try {
      const confirmRes  = await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions })
      });
      const confirmData = await confirmRes.json();
      wrap.remove();
      loadTasks();
      if (confirmData.habit_changed) loadHabits();
      if (confirmData.goal_changed)  loadGoals();
      actions.forEach(a => addNotif('chat_action', a.label));
      // Build a summary of what was done so the response is always informative
      const summary = actions.map(a => a.label).join(', ');
      const _dv = DONE_VOICES[tier()] || ['done!'];
      const doneWord = _dv[Math.floor(Math.random() * _dv.length)];
      const msg = actions.length === 1 ? `${doneWord} — ${summary}` : `${doneWord} all ${actions.length} done: ${summary}`;
      chatHistory.push({ role: 'assistant', content: `${msg} [actions confirmed and completed]` });
      appendBlobBubble(msg);
      say(msg, 4000);
    } catch (_) {
      acceptBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> confirm`;
      acceptBtn.disabled = false;
      declineBtn.disabled = false;
    }
  });

  declineBtn.addEventListener('click', () => {
    wrap.remove();
    const voices = {
      terrified: ['o-ok...', 'n-no worries...', '...okay'],
      shy:       ['oh, ok...', 'that\'s fine...', 'no worries!'],
      cautious:  ['alright, never mind!', 'ok, no problem!', 'got it, cancelling'],
      friendly:  ['ok no worries!', 'all good!!', 'sure, maybe later!'],
      bonded:    ['ok!! maybe next time!!', 'NO PROBLEM!! next time!!', 'ok ok!! cancelled!!'],
    };
    const _vm = voices[tier()] || ['ok!'];
    const msg = _vm[Math.floor(Math.random() * _vm.length)];
    appendBlobBubble(msg);
    chatHistory.push({ role: 'assistant', content: `${msg} [user declined — action was NOT done]` });
  });

  btns.appendChild(acceptBtn);
  btns.appendChild(declineBtn);
  wrap.appendChild(rows);
  wrap.appendChild(btns);
  chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

// Task reference card — renders current tasks as a formatted list in chat
function appendTaskRefCard() {
  if (!tasks.length) return;
  const pending = tasks.filter(t => !t.done);
  const wrap = document.createElement('div');
  wrap.className = 'chat-bubble blob-bubble task-ref-card';
  const shown = tasks.slice(0, 6);
  const extra = tasks.length - shown.length;
  wrap.innerHTML = `
    <div class="task-ref-header">
      <span class="task-ref-title">your tasks</span>
      <span class="task-ref-count">${pending.length} pending</span>
    </div>
    <ul class="task-ref-list">
      ${shown.map(t => `
        <li class="task-ref-item ${t.done ? 'done' : ''}">
          <span class="task-ref-dot ${t.done ? 'done' : ''}"></span>
          <span class="task-ref-text">${esc(t.title)}</span>
          ${makeTagHtml(t.category)}
        </li>`).join('')}
    </ul>
    ${extra > 0 ? `<div class="task-ref-more">+${extra} more</div>` : ''}`;
  chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

// ── Habit ref card ────────────────────────────────────────────────────────────
let chatHabits = [];  // kept in sync after each loadHabits call

const DIFF_LABEL_COLOR = { easy:'#4ade80', medium:'#fb923c', hard:'#f87171' };

function appendHabitRefCard() {
  if (!chatHabits.length) return;
  const today   = new Date().toISOString().slice(0,10);
  const active  = chatHabits.filter(h => !h.paused);
  const wrap    = document.createElement('div');
  wrap.className = 'chat-bubble blob-bubble habit-ref-card';

  const items = chatHabits.slice(0,6).map(h => {
    const done   = h.last_done && h.last_done.slice(0,10) === today;
    const paused = !!h.paused;
    const dc     = DIFF_LABEL_COLOR[h.difficulty] || '#a78bfa';
    return `<li class="habit-ref-item ${done ? 'done' : ''} ${paused ? 'paused' : ''}">
      <span class="habit-ref-dot ${done ? 'done' : paused ? 'paused' : ''}"></span>
      <span class="habit-ref-name">${esc(h.title)}</span>
      <span class="habit-ref-diff" style="color:${dc};border-color:${dc}33">${h.difficulty}</span>
      ${h.streak > 0 ? `<span class="habit-ref-streak">${IC.flame(10,'#f97316')} ${h.streak}</span>` : ''}
      ${done ? `<span class="habit-ref-done-badge">✓</span>` : ''}
    </li>`;
  }).join('');

  const extra = chatHabits.length - 6;
  wrap.innerHTML = `
    <div class="habit-ref-header">
      <span class="habit-ref-title">your habits</span>
      <span class="habit-ref-count">${active.length} active</span>
    </div>
    <ul class="habit-ref-list">${items}</ul>
    ${extra > 0 ? `<div class="habit-ref-more">+${extra} more</div>` : ''}
    <button class="habit-ref-open-btn">open habits →</button>`;

  wrap.querySelector('.habit-ref-open-btn').addEventListener('click', () => {
    closeChat();
    showScreen('habits', 'add');
  });

  chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

function appendHabitTag(habit) {
  if (!habit) return;
  const today  = new Date().toISOString().slice(0,10);
  const done   = habit.last_done && habit.last_done.slice(0,10) === today;
  const dc     = DIFF_LABEL_COLOR[habit.difficulty] || '#a78bfa';
  const wrap   = document.createElement('div');
  wrap.className = 'chat-quick-replies';
  const chip   = document.createElement('button');
  chip.className = 'quick-chip habit-chip';
  chip.innerHTML = `${IC.flame(11, done ? '#4ade80' : '#f97316')} <span>${esc(habit.title)}</span> <span class="habit-chip-diff" style="color:${dc}">${habit.difficulty}</span> <span class="habit-chip-arrow">→</span>`;
  chip.addEventListener('click', () => {
    wrap.remove();
    closeChat();
    showScreen('habits', 'add');
  });
  wrap.appendChild(chip);
  chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

// ── Goal ref card ─────────────────────────────────────────────────────────────
function appendGoalRefCard() {
  if (!chatGoals.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'chat-bubble blob-bubble goal-ref-card';

  const items = chatGoals.slice(0, 5).map(g => {
    const cat   = GOAL_CATS[g.category] || DEFAULT_CAT;
    const pct   = g.progress;
    const total = g.milestone_total || 0;
    const done  = g.milestone_done  || 0;
    const complete = pct >= 100;
    return `<li class="goal-ref-item ${complete ? 'complete' : ''}">
      <span class="goal-ref-dot" style="background:${complete ? '#4ade80' : cat.color}"></span>
      <span class="goal-ref-name">${esc(g.title)}</span>
      <span class="goal-ref-cat" style="color:${cat.color}">${g.category}</span>
      <span class="goal-ref-prog">${total > 0 ? `${done}/${total}` : `${pct}%`}</span>
    </li>`;
  }).join('');

  const extra = chatGoals.length - 5;
  wrap.innerHTML = `
    <div class="goal-ref-header">
      <span class="goal-ref-title">your goals</span>
      <span class="goal-ref-count">${chatGoals.filter(g => g.progress < 100).length} active</span>
    </div>
    <ul class="goal-ref-list">${items}</ul>
    ${extra > 0 ? `<div class="habit-ref-more">+${extra} more</div>` : ''}
    <button class="goal-ref-open-btn">open goals →</button>`;

  wrap.querySelector('.goal-ref-open-btn').addEventListener('click', () => {
    closeChat();
    showScreen('goals', 'add');
  });

  chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

function appendGoalTag(goal) {
  if (!goal) return;
  const cat  = GOAL_CATS[goal.category] || DEFAULT_CAT;
  const pct  = goal.progress;
  const wrap = document.createElement('div');
  wrap.className = 'chat-quick-replies';
  const chip = document.createElement('button');
  chip.className = 'quick-chip goal-chip';
  chip.innerHTML = `<span class="goal-chip-dot" style="background:${cat.color}"></span> <span>${esc(goal.title)}</span> <span class="goal-chip-pct" style="color:${cat.color}">${pct}%</span> <span class="habit-chip-arrow">→</span>`;
  chip.addEventListener('click', () => {
    wrap.remove();
    closeChat();
    expandedGoalId = goal.id;
    showScreen('goals', 'add');
  });
  wrap.appendChild(chip);
  chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

// Quick-reply chips — shown after plain conversational responses
const _TASK_QUERY_RE  = /\b(tasks?|have|list|what|all|do i|everything|pending|todo|remind)\b/i;
const _HABIT_QUERY_RE = /\b(habit|habits|streak|routine|daily|practice)\b/i;
const _GOAL_QUERY_RE  = /\b(goal|goals|achieve|achievement|target|milestone|objective|outcome)\b/i;

function appendQuickReplies(userMessage) {
  const chips = [];
  if (!pomo.active) {
    chips.push({ text: '⏱ start focus', fill: 'start a focus session' });
  }
  chips.push({ text: '+ add task', action: () => { closeChat(); setTimeout(openModal, 120); } });
  chips.push({ text: '+ add habit', fill: 'add a habit' });
  chips.push({ text: '+ add goal',  fill: 'I want to achieve' });

  if (!chips.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'chat-quick-replies';
  chips.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'quick-chip';
    btn.textContent = c.text;
    btn.addEventListener('click', () => {
      wrap.remove();
      if (c.action) { c.action(); return; }
      if (c.fill)   { chatInput.value = c.fill; chatInput.focus(); }
    });
    wrap.appendChild(btn);
  });
  chatMessages.appendChild(wrap);
  scrollChatToBottom();
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatSendBtn.disabled = true;

  const reply = replyContext ? { ...replyContext } : null;
  clearReply();

  appendUserBubble(text, reply);
  const aiText = reply ? `(replying to: "${reply.text.slice(0, 80)}") ${text}` : text;
  chatHistory.push({ role: 'user', content: aiText });

  const thinkingEl = appendBlobBubble('...', true);

  try {
    const allCats = [...BUILT_IN_CATS, ...getCustomTags().map(t => t.name)];
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: chatHistory.slice(-8),
        time: new Date().toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }),
        stats: {
          familiarity: Math.round(localStats.familiarity),
          energy:      Math.round(localStats.energy),
          happiness:   Math.round(localStats.happiness),
        },
        categories: allCats,
        focus: {
          active:        pomo.active,
          paused:        pomo.paused,
          phase:         pomo.phase,
          remaining_min: Math.ceil(pomo.remaining / 60),
          task_title:    pomo.taskTitle,
          count:         pomo.count,
          work_min:      focusSettings.work,
        },
        focus_history: focusSessions.slice(0, 6).map(s => ({ label: s.label, duration: s.duration })),
      })
    });
    const data = await res.json();
    thinkingEl.remove();

    const reply = data.message || '...';
    appendBlobBubble(reply);
    say(reply, 3000);

    // Execute immediate focus actions
    if (data.focus_result) {
      const r = data.focus_result;
      if (r.focus_started) {
        const override = {};
        if (r.work_minutes)  override.work  = r.work_minutes;
        if (r.short_minutes) override.short = r.short_minutes;
        if (r.long_minutes)  override.long  = r.long_minutes;
        startPomodoro(r.task_id, r.task_title, Object.keys(override).length ? override : null);
      }
      if (r.pause_focus && pomo.active)  pausePomodoro();
      if (r.resume_focus && pomo.active) resumePomodoro();
      if (r.stop_focus && pomo.active)   { stopPomodoro(); react('idle'); }
      if (r.skip_focus && pomo.active)   { pomo.remaining = 0; advancePomodoro(); }
      // Immediate habit check-in
      if (r.habit_checked && r.habit) {
        addNotif('habit_checked', `"${r.habit.title}" checked in · ${r.habit.streak} day streak`);
        if (r.pet) updatePetUI(r.pet);
        react('habit_checked');
        await loadHabits();
        appendHabitTag(r.habit);
      }
      if (r.already_done && r.habit) {
        addNotif('habit_checked', `"${r.habit.title}" already done today`);
        appendHabitTag(r.habit);
      }
      // Immediate milestone complete
      if (r.milestone_completed && r.goal) {
        const notifMsg = r.goal_complete
          ? `goal "${r.goal.title}" complete!`
          : `milestone done · ${r.goal.milestone_done}/${r.goal.milestone_total} steps`;
        addNotif('goal_progress', notifMsg);
        if (r.goal_complete) react('goal_progress');
        await loadGoals();
        appendGoalTag(r.goal);
      }
    }

    if (data.proposed_actions && data.proposed_actions.length) {
      const actionSummary = data.proposed_actions.map(a => a.label).join('; ');
      chatHistory.push({ role: 'assistant', content: `${reply} [awaiting confirmation to: ${actionSummary}]` });
      showActionCard(data.proposed_actions);
    } else {
      chatHistory.push({ role: 'assistant', content: reply });
      // Show task reference card if user was asking about their tasks
      if (_TASK_QUERY_RE.test(text) && tasks.length && !data.focus_result) {
        appendTaskRefCard();
      } else if (_GOAL_QUERY_RE.test(text) && chatGoals.length && !data.focus_result) {
        appendGoalRefCard();
      } else if (_HABIT_QUERY_RE.test(text) && chatHabits.length) {
        // Show habit ref card for habit questions
        appendHabitRefCard();
      } else if (!data.focus_result) {
        // Plain conversational response — show quick-reply chips
        appendQuickReplies(text);
      }
    }

    if (data.effects) {
      const fx = data.effects;
      if (fx.familiarity) localStats.familiarity = clampStat(localStats.familiarity + fx.familiarity);
      if (fx.happiness)   localStats.happiness   = clampStat(localStats.happiness   + fx.happiness);
      if (fx.energy)      localStats.energy      = clampStat(localStats.energy      + fx.energy);
      saveLocalStats();
      if (fx.expression && fx.expression !== 'normal') showExpression(fx.expression, 2200);
      refreshMood();
    }
  } catch (err) {
    console.error('Chat error:', err);
    thinkingEl.textContent = 'something went wrong, try again';
    thinkingEl.classList.remove('thinking');
  }

  chatSendBtn.disabled = false;
}

document.getElementById('closeChatBtn').addEventListener('click', closeChat);
chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });

chatMessages.addEventListener('click', e => {
  const copyBtn = e.target.closest('.bubble-copy');
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.copyText || '').catch(() => {});
    copyBtn.classList.add('copied');
    setTimeout(() => copyBtn.classList.remove('copied'), 1400);
    return;
  }
  const delBtn = e.target.closest('.bubble-delete');
  if (delBtn) {
    const bubble = delBtn.closest('.chat-bubble');
    if (bubble) {
      bubble.style.transition = 'opacity 0.18s, transform 0.18s';
      bubble.style.opacity = '0';
      bubble.style.transform = 'scale(0.92)';
      setTimeout(() => bubble.remove(), 180);
    }
  }
});

// ── Memories ──────────────────────────────────────────────────────────────────
async function loadMemories() {
  try {
    const res  = await fetch('/api/memories');
    const data = await res.json();
    const el   = document.getElementById('memoriesContent');
    let html = '';

    if (data.journal && data.journal.length) {
      html += `<div class="memories-section">
        <div class="memories-section-title">journal</div>
        ${data.journal.map(j => `
          <div class="memory-card">
            <div class="memory-card-text">${esc(j.text)}</div>
            <div class="memory-card-date">${fmtDate(j.created_at)}</div>
          </div>`).join('')}
      </div>`;
    }

    if (data.completed && data.completed.length) {
      html += `<div class="memories-section">
        <div class="memories-section-title">completed tasks</div>
        <div class="memory-card">
          ${data.completed.map(t => `
            <div class="memory-task-item">
              <div class="memory-task-check"></div>
              <span>${esc(t.title)}</span>
            </div>`).join('')}
        </div>
      </div>`;
    }

    el.innerHTML = html || '<p class="empty-state">nothing here yet!</p>';
  } catch(e) {}
}

// ── Achievements ──────────────────────────────────────────────────────────────
async function loadAchievements() {
  try {
    const res  = await fetch('/api/achievements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ familiarity: Math.round(localStats.familiarity) })
    });
    const data = await res.json();
    const el   = document.getElementById('achievementsContent');
    el.innerHTML = data.map(a => {
      const iconFn    = IC[a.icon];
      const iconColor = a.unlocked ? a.color : 'rgba(255,255,255,0.15)';
      const iconHtml  = iconFn ? iconFn(26, iconColor) : '';
      const glow      = a.unlocked ? `drop-shadow(0 0 7px ${a.color}88)` : 'none';
      return `
        <div class="achievement-card ${a.unlocked ? '' : 'locked'}" style="--ach-color:${a.color}">
          <div class="achievement-icon" style="filter:${glow}">${iconHtml}</div>
          <div class="achievement-info">
            <div class="achievement-name">${esc(a.name)}</div>
            <div class="achievement-desc">${esc(a.desc)}</div>
          </div>
          <span class="achievement-badge ${a.unlocked ? 'badge-unlocked' : ''}">${a.unlocked ? 'unlocked' : 'locked'}</span>
        </div>`;
    }).join('');
  } catch(e) {}
}

// ── Shop ──────────────────────────────────────────────────────────────────────
const SHOP_ITEM_ICONS = {
  bow:          `<svg width="32" height="26" viewBox="0 0 60 46" fill="none"><path d="M24 30 Q9 12 17 5 Q27 3 30 22" fill="#f472b6" stroke="#ec4899" stroke-width="2"/><path d="M36 30 Q51 12 43 5 Q33 3 30 22" fill="#f472b6" stroke="#ec4899" stroke-width="2"/><circle cx="30" cy="24" r="9" fill="#ec4899"/><circle cx="30" cy="24" r="5.5" fill="#f472b6"/><circle cx="30" cy="24" r="2.5" fill="#fce7f3"/></svg>`,
  sunglasses:   `<svg width="32" height="18" viewBox="0 0 56 20" fill="none"><ellipse cx="14" cy="10" rx="12" ry="9" fill="rgba(60,20,120,0.75)" stroke="#7c3aed" stroke-width="1.8"/><ellipse cx="42" cy="10" rx="12" ry="9" fill="rgba(60,20,120,0.75)" stroke="#7c3aed" stroke-width="1.8"/><line x1="26" y1="10" x2="30" y2="10" stroke="#7c3aed" stroke-width="2.2"/></svg>`,
  cat_ears:     `<svg width="34" height="32" viewBox="0 0 60 52" fill="none"><polygon points="14,50 4,16 26,30" fill="#f9a8d4" stroke="#ec4899" stroke-width="2"/><polygon points="17,46 8,20 23,30" fill="#fce7f3" opacity="0.9"/><polygon points="46,50 56,16 34,30" fill="#f9a8d4" stroke="#ec4899" stroke-width="2"/><polygon points="43,46 52,20 37,30" fill="#fce7f3" opacity="0.9"/></svg>`,
  flower:       `<svg width="32" height="32" viewBox="0 0 56 56" fill="none"><g transform="translate(28,28)"><ellipse cx="0" cy="-14" rx="7" ry="12" fill="#fde68a"/><ellipse cx="0" cy="-14" rx="7" ry="12" fill="#fde68a" transform="rotate(72)"/><ellipse cx="0" cy="-14" rx="7" ry="12" fill="#fde68a" transform="rotate(144)"/><ellipse cx="0" cy="-14" rx="7" ry="12" fill="#fde68a" transform="rotate(216)"/><ellipse cx="0" cy="-14" rx="7" ry="12" fill="#fde68a" transform="rotate(288)"/><circle cx="0" cy="0" r="10" fill="#f97316"/><circle cx="0" cy="0" r="6" fill="#fbbf24"/></g></svg>`,
  lucky_charm:  `<svg width="30" height="30" viewBox="0 0 28 28" fill="#f59e0b"><polygon points="14 2 17 10.5 26 10.5 19 16 21.5 24.5 14 19.5 6.5 24.5 9 16 2 10.5 11 10.5"/></svg>`,
  party_hat:    `<svg width="26" height="32" viewBox="0 0 44 54" fill="none"><polygon points="22,2 4,52 40,52" fill="#f97316" stroke="#c2410c" stroke-width="1.8"/><circle cx="22" cy="2" r="6" fill="#fbbf24"/><line x1="10" y1="36" x2="34" y2="36" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  monocle:      `<svg width="30" height="30" viewBox="0 0 52 52" fill="none" stroke="#b45309" stroke-width="3"><circle cx="22" cy="22" r="18"/><circle cx="22" cy="22" r="14" fill="rgba(217,119,6,0.12)" stroke="none"/><path d="M37 37 Q46 44 43 50" stroke-linecap="round" stroke-dasharray="3,3"/></svg>`,
  top_hat:      `<svg width="32" height="36" viewBox="0 0 54 58" fill="none"><rect x="15" y="5" width="24" height="36" rx="3" fill="#0f172a"/><rect x="16" y="6" width="10" height="34" rx="2" fill="#1e293b" opacity="0.5"/><rect x="15" y="33" width="24" height="8" fill="#7c3aed"/><rect x="15" y="33" width="24" height="4" fill="#a78bfa" opacity="0.3"/><rect x="5" y="39" width="44" height="8" rx="4" fill="#0f172a"/><rect x="5" y="39" width="44" height="3" rx="2" fill="#1e293b" opacity="0.5"/></svg>`,
  scarf:        `<svg width="36" height="28" viewBox="0 0 62 44" fill="none"><path d="M4 12 Q31 6 58 12 Q60 24 58 28 Q31 22 4 28 Q2 24 4 12Z" fill="#ef4444"/><path d="M4 14 Q31 8 58 14 L58 19 Q31 13 4 19Z" fill="#fca5a5" opacity="0.4"/><rect x="20" y="24" width="12" height="20" rx="5" fill="#ef4444"/><rect x="23" y="24" width="6" height="20" rx="3" fill="#fca5a5" opacity="0.35"/></svg>`,
  headphones:   `<svg width="32" height="28" viewBox="0 0 56 48" fill="none"><path d="M8 30 Q28 2 48 30" stroke="#4338ca" stroke-width="6" stroke-linecap="round"/><ellipse cx="8" cy="35" rx="7" ry="10" fill="#4338ca"/><ellipse cx="48" cy="35" rx="7" ry="10" fill="#4338ca"/><ellipse cx="8" cy="33" rx="4" ry="6" fill="#6366f1" opacity="0.7"/><ellipse cx="48" cy="33" rx="4" ry="6" fill="#6366f1" opacity="0.7"/></svg>`,
  frost_badge:  `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round"><line x1="14" y1="2" x2="14" y2="26"/><line x1="2" y1="14" x2="26" y2="14"/><line x1="5.5" y1="5.5" x2="22.5" y2="22.5"/><line x1="22.5" y1="5.5" x2="5.5" y2="22.5"/></svg>`,
  wizard_hat:   `<svg width="30" height="34" viewBox="0 0 52 58" fill="none"><polygon points="26,2 6,54 46,54" fill="#6d28d9" stroke="#4c1d95" stroke-width="2"/><polygon points="26,16 28,24 36,24 30,30 32,38 26,33 20,38 22,30 16,24 24,24" fill="#fbbf24" opacity="0.9"/><ellipse cx="26" cy="53" rx="28" ry="7" fill="#7c3aed" stroke="#4c1d95" stroke-width="1.5"/></svg>`,
  devil_horns:  `<svg width="32" height="26" viewBox="0 0 56 42" fill="none"><path d="M13 38 Q4 18 10 6 Q18 16 20 32" fill="#ef4444" stroke="#dc2626" stroke-width="1.5"/><path d="M43 38 Q52 18 46 6 Q38 16 36 32" fill="#ef4444" stroke="#dc2626" stroke-width="1.5"/><path d="M13 38 Q5 22 8 10 Q14 18 15 28" fill="#fca5a5" opacity="0.4"/><path d="M43 38 Q51 22 48 10 Q42 18 41 28" fill="#fca5a5" opacity="0.4"/></svg>`,
  angel_wings:  `<svg width="40" height="30" viewBox="0 0 66 46" fill="none"><path d="M28 40 Q6 30 8 10 Q16 22 26 38" fill="rgba(248,250,255,0.92)" stroke="rgba(199,210,254,0.6)" stroke-width="1.2"/><path d="M28 34 Q8 20 12 4 Q20 16 26 32" fill="rgba(240,245,255,0.78)"/><path d="M28 26 Q12 12 20 0 Q26 12 28 24" fill="rgba(230,238,255,0.6)"/><path d="M38 40 Q60 30 58 10 Q50 22 40 38" fill="rgba(248,250,255,0.92)" stroke="rgba(199,210,254,0.6)" stroke-width="1.2"/><path d="M38 34 Q58 20 54 4 Q46 16 40 32" fill="rgba(240,245,255,0.78)"/><path d="M38 26 Q54 12 46 0 Q40 12 38 24" fill="rgba(230,238,255,0.6)"/></svg>`,
  hero_cape:    `<svg width="32" height="26" viewBox="0 0 56 44" fill="none"><path d="M6 6 Q4 24 8 36 Q28 46 48 36 Q52 24 50 6 L28 16Z" fill="#7c3aed" opacity="0.9"/><path d="M6 6 Q4 24 8 36 Q28 46 48 36 Q52 24 50 6" fill="none" stroke="#6d28d9" stroke-width="1.8"/></svg>`,
  crown:        `<svg width="34" height="26" viewBox="0 0 60 42" fill="none"><path d="M8 38 L8 26 L18 34 L30 10 L42 34 L52 26 L52 38 Z" fill="#f59e0b" stroke="#d97706" stroke-width="2"/><circle cx="30" cy="14" r="5.5" fill="#ef4444"/><circle cx="18" cy="32" r="4" fill="#60a5fa"/><circle cx="42" cy="32" r="4" fill="#60a5fa"/><rect x="8" y="36" width="44" height="7" rx="3" fill="#d97706"/></svg>`,
  halo:         `<svg width="34" height="20" viewBox="0 0 60 32" fill="none"><ellipse cx="30" cy="12" rx="26" ry="8" fill="none" stroke="#f59e0b" stroke-width="7" opacity="0.9"/><ellipse cx="30" cy="12" rx="26" ry="8" fill="none" stroke="#fef08a" stroke-width="3" opacity="0.8"/><ellipse cx="30" cy="12" rx="26" ry="8" fill="none" stroke="#fbbf24" stroke-width="14" opacity="0.1"/></svg>`,
  dragon_wings: `<svg width="42" height="32" viewBox="0 0 70 52" fill="none"><path d="M28 46 Q4 34 6 10 L18 24 L6 8 L24 22 L10 2 L30 20 L22 0 L34 22 L30 44" fill="#5b21b6" opacity="0.9" stroke="#7c3aed" stroke-width="1.5"/><line x1="20" y1="24" x2="30" y2="44" stroke="#a78bfa" stroke-width="1.2" opacity="0.55"/><line x1="8" y1="10" x2="30" y2="40" stroke="#a78bfa" stroke-width="1.2" opacity="0.4"/><path d="M42 46 Q66 34 64 10 L52 24 L64 8 L46 22 L60 2 L40 20 L48 0 L36 22 L40 44" fill="#5b21b6" opacity="0.9" stroke="#7c3aed" stroke-width="1.5"/><line x1="50" y1="24" x2="40" y2="44" stroke="#a78bfa" stroke-width="1.2" opacity="0.55"/><line x1="62" y1="10" x2="40" y2="40" stroke="#a78bfa" stroke-width="1.2" opacity="0.4"/></svg>`,
};

const SHOP_ITEM_EFFECTS = {
  bow:          { label: 'purely adorable',          color: '#f472b6', tier: 'common',    tierColor: '#9ca3af' },
  sunglasses:   { label: '+1 familiarity / chat',    color: '#a78bfa', tier: 'common',    tierColor: '#9ca3af' },
  cat_ears:     { label: 'meow energy only',         color: '#f9a8d4', tier: 'common',    tierColor: '#9ca3af' },
  flower:       { label: 'blooming adorable',        color: '#fbbf24', tier: 'common',    tierColor: '#9ca3af' },
  lucky_charm:  { label: 'task coins ×1.5',          color: '#f59e0b', tier: 'rare',      tierColor: '#60a5fa' },
  party_hat:    { label: 'streak bonus at day 3',    color: '#f97316', tier: 'rare',      tierColor: '#60a5fa' },
  monocle:      { label: '+3 coins per task',        color: '#d97706', tier: 'rare',      tierColor: '#60a5fa' },
  top_hat:      { label: '+2 coins per task',        color: '#94a3b8', tier: 'rare',      tierColor: '#60a5fa' },
  scarf:        { label: 'feed blob for 20 coins',   color: '#ef4444', tier: 'rare',      tierColor: '#60a5fa' },
  headphones:   { label: 'habit coins ×1.5',         color: '#818cf8', tier: 'epic',      tierColor: '#a78bfa' },
  frost_badge:  { label: '+2 freeze tokens',         color: '#7dd3fc', tier: 'epic',      tierColor: '#a78bfa' },
  wizard_hat:   { label: 'habit coins ×2',           color: '#7c3aed', tier: 'epic',      tierColor: '#a78bfa' },
  devil_horns:  { label: '+5 coins every action',    color: '#ef4444', tier: 'epic',      tierColor: '#a78bfa' },
  angel_wings:  { label: '+1 familiarity / chat',    color: '#c7d2fe', tier: 'epic',      tierColor: '#a78bfa' },
  hero_cape:    { label: 'all coins ×1.25',          color: '#7c3aed', tier: 'legendary', tierColor: '#f59e0b' },
  crown:        { label: 'all coins ×1.5',           color: '#f59e0b', tier: 'legendary', tierColor: '#f59e0b' },
  halo:         { label: '+2 familiarity / chat',    color: '#fbbf24', tier: 'legendary', tierColor: '#f59e0b' },
  dragon_wings: { label: '+10 coins every action',   color: '#8b5cf6', tier: 'legendary', tierColor: '#f59e0b' },
};

const ACC_ID_MAP = {
  sunglasses:'sunglasses', party_hat:'party-hat',   headphones:'headphones',
  hero_cape:'hero-cape',   lucky_charm:'lucky-charm', frost_badge:'frost-badge',
  bow:'bow',               monocle:'monocle',         wizard_hat:'wizard-hat',
  crown:'crown',           halo:'halo',               devil_horns:'devil-horns',
  cat_ears:'cat-ears',     flower:'flower',           top_hat:'top-hat',
  scarf:'scarf',           angel_wings:'angel-wings', dragon_wings:'dragon-wings',
};

let _lastEquippedSet = new Set();

function updateBlobAccessories(ownedEquipped, preview = null) {
  _lastEquippedSet = ownedEquipped;
  const show = new Set(ownedEquipped);
  if (preview) show.add(preview);
  Object.entries(ACC_ID_MAP).forEach(([apiId, htmlId]) => {
    const el = document.getElementById(`acc-${htmlId}`);
    if (el) el.setAttribute('display', show.has(apiId) ? '' : 'none');
  });
  const cape = document.getElementById('acc-hero-cape');
  const body = document.querySelector('#blob .blob-body');
  const svgEl = cape && cape.parentNode;
  if (cape && body && svgEl && show.has('hero_cape')) svgEl.insertBefore(cape, body);
}

// ── Blob preview (heart screen) ───────────────────────────────────────────────
function syncBlobPreview() {
  const previewEl = document.getElementById('blobPreview');
  if (!previewEl) return;
  const moodClass = [...blobEl.classList].find(c => c.startsWith('mood-')) || 'mood-happy';
  previewEl.className = `blob blob-preview ${moodClass}`;
  const tierGlowColors = { terrified:'#f87171', shy:'#fb923c', cautious:'#facc15', friendly:'#4ade80', bonded:'#a78bfa' };
  const glowEl = document.getElementById('blobHeroGlow');
  if (glowEl) {
    const c = tierGlowColors[tier()] || '#a78bfa';
    glowEl.style.background = `radial-gradient(ellipse 80% 65% at 50% 45%, ${c}20 0%, transparent 70%)`;
  }
}

function syncPreviewAccessories(equippedSet) {
  Object.entries(ACC_ID_MAP).forEach(([apiId, htmlId]) => {
    const el = document.getElementById(`prev-acc-${htmlId}`);
    if (el) el.setAttribute('display', equippedSet.has(apiId) ? '' : 'none');
  });
  if (equippedSet.has('hero_cape')) {
    const cape = document.getElementById('prev-acc-hero-cape');
    const body = document.getElementById('blobPreview')?.querySelector('.blob-body');
    if (cape && body && cape.parentNode) cape.parentNode.insertBefore(cape, body);
  }
}

function enterHeroMode() {
  clearTimeout(heroReturnTimer);
  if (!document.getElementById('screen-heart')?.classList.contains('active')) return;
  const stageEl = document.getElementById('blobHeroStage');
  if (!stageEl) return;
  const phoneRect = phone.getBoundingClientRect();
  const stageRect = stageEl.getBoundingClientRect();
  const footerH   = 60;
  const centerAreaH = stageRect.height - footerH;
  heroTargetX = ((stageRect.left + stageRect.width / 2 - phoneRect.left) / phoneRect.width)  * 100;
  heroTargetY = ((stageRect.top  + centerAreaH / 2     - phoneRect.top)  / phoneRect.height) * 100;
  heroScaleTarget = 1.9;
  heroMode = true;
  attract  = null;
  blobEl.style.zIndex = '200';
  clearTimeout(restTimer);
  const previewEl = document.getElementById('blobPreview');
  if (previewEl) { previewEl.style.transition = 'opacity 0.15s'; previewEl.style.opacity = '0'; }
}

function exitHeroMode() {
  heroMode = false;
  heroScaleTarget = 1.0;
  blobEl.style.zIndex = '50';
  bvx = (Math.random() - 0.5) * 0.25;
  bvy = -0.15 - Math.random() * 0.2;
  const onHeart = document.getElementById('screen-heart')?.classList.contains('active');
  if (onHeart) {
    // Don't show the preview — schedule the blob back to hero position instead
    heroReturnTimer = setTimeout(enterHeroMode, 2500);
  } else {
    setTimeout(() => {
      const previewEl = document.getElementById('blobPreview');
      if (previewEl) { previewEl.style.transition = 'opacity 0.3s'; previewEl.style.opacity = '1'; }
    }, 250);
  }
  scheduleNextRest(2500);
}

function enterShopPreview() {
  const stage = document.getElementById('shopBlobStage');
  if (!stage) return;
  const phoneRect = phone.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  shopTargetX = ((stageRect.left + stageRect.width  / 2 - phoneRect.left) / phoneRect.width)  * 100;
  shopTargetY = ((stageRect.top  + stageRect.height / 2 - phoneRect.top)  / phoneRect.height) * 100;
  shopPreviewMode  = true;
  heroScaleTarget  = 1.75;
  bvx = 0; bvy = 0;
  attract = null;
  blobEl.style.zIndex = '200';
  // Glow colour from tier
  const glowEl = document.getElementById('shopBlobGlow');
  if (glowEl) {
    const tierGlowColors = { terrified:'#f87171', shy:'#fb923c', cautious:'#facc15', friendly:'#4ade80', bonded:'#a78bfa' };
    const c = tierGlowColors[tier()] || '#a78bfa';
    glowEl.style.background = `radial-gradient(ellipse 75% 70% at 50% 55%, ${c}28 0%, transparent 72%)`;
  }
}

function exitShopPreview() {
  shopPreviewMode = false;
  heroScaleTarget  = 1.0;
  blobEl.style.zIndex = '50';
  bvx = (Math.random() - 0.5) * 0.2;
  bvy = -0.1;
}

async function loadEquippedDisplay() {
  try {
    const [shopRes, petRes] = await Promise.all([fetch('/api/shop'), fetch('/api/pet')]);
    const items = await shopRes.json();
    const pet   = await petRes.json();
    const hcd = document.getElementById('heartCoinDisplay');
    if (hcd) hcd.textContent = pet.coins;
    const equipped = new Set(items.filter(i => i.owned && i.equipped).map(i => i.id));
    syncPreviewAccessories(equipped);
    const wearingList = document.getElementById('blobWearingList');
    if (!wearingList) return;
    const equippedItems = items.filter(i => i.owned && i.equipped);
    if (equippedItems.length === 0) {
      wearingList.innerHTML = '<span class="blob-wearing-empty">nothing equipped yet — visit the shop!</span>';
    } else {
      wearingList.innerHTML = equippedItems.map(item => {
        const eff = SHOP_ITEM_EFFECTS[item.id] || {};
        const ic  = SHOP_ITEM_ICONS[item.id]   || '';
        return `<div class="blob-wearing-chip" style="border-color:${eff.color||'#a78bfa'}33;background:${eff.color||'#7c3aed'}0d">
          <span class="blob-wearing-chip-icon">${ic}</span>
          <span class="blob-wearing-chip-name">${esc(item.name)}</span>
        </div>`;
      }).join('');
    }
  } catch(e) {}
}

// ── Try-on ───────────────────────────────────────────────────────────────────
let tryOnId = null;

const ITEM_NAMES = {
  sunglasses:'Sunglasses',   lucky_charm:'Lucky Charm',  party_hat:'Party Hat',
  headphones:'Headphones',   frost_badge:'Frost Badge',  hero_cape:'Hero Cape',
  bow:'Bow',                 monocle:'Monocle',          wizard_hat:'Wizard Hat',
  crown:'Crown',             halo:'Halo',                devil_horns:'Devil Horns',
  cat_ears:'Cat Ears',       flower:'Flower',            top_hat:'Top Hat',
  scarf:'Scarf',             angel_wings:'Angel Wings',  dragon_wings:'Dragon Wings',
};

function tryOnItem(id) {
  tryOnId = id;
  updateBlobAccessories(_lastEquippedSet, id);
  const banner = document.getElementById('tryOnBanner');
  const nameEl = document.getElementById('tryOnName');
  if (banner) banner.classList.remove('hidden');
  if (nameEl)  nameEl.textContent = ITEM_NAMES[id] || id;
  document.querySelectorAll('.shop-card').forEach(c =>
    c.classList.toggle('trying', c.dataset.item === id)
  );
}

function stopTryOn() {
  tryOnId = null;
  updateBlobAccessories(_lastEquippedSet);
  const banner = document.getElementById('tryOnBanner');
  if (banner) banner.classList.add('hidden');
  document.querySelectorAll('.shop-card').forEach(c => c.classList.remove('trying'));
}

const TIER_ORDER = ['common','rare','epic','legendary'];
const TIER_LABELS = { common:'Common', rare:'Rare', epic:'Epic', legendary:'Legendary ✦' };

let shopCurrentTier = 'all';

async function loadShop() {
  try {
    const [shopRes, petRes] = await Promise.all([fetch('/api/shop'), fetch('/api/pet')]);
    const items = await shopRes.json();
    const pet   = await petRes.json();

    const coinsEl = document.getElementById('shopCoins');
    if (coinsEl) coinsEl.textContent = pet.coins;

    const equipped = new Set(items.filter(i => i.owned && i.equipped).map(i => i.id));
    updateBlobAccessories(equipped, tryOnId);

    const byTier = {};
    TIER_ORDER.forEach(t => byTier[t] = []);
    items.forEach(item => {
      const t = (SHOP_ITEM_EFFECTS[item.id] || {}).tier || 'common';
      if (byTier[t]) byTier[t].push(item);
    });

    const tiersToShow = shopCurrentTier === 'all' ? TIER_ORDER : [shopCurrentTier];
    const coinSvg = `<svg width="9" height="9" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="2.2" fill="currentColor"/></svg>`;

    const grid = document.getElementById('shopGrid');
    grid.innerHTML = tiersToShow.flatMap(tier => {
      const tierItems = byTier[tier];
      if (!tierItems || !tierItems.length) return [];
      const tc = (SHOP_ITEM_EFFECTS[tierItems[0].id] || {}).tierColor || '#9ca3af';

      const header = `
        <div class="shop-tier-header">
          <div class="shop-tier-dot" style="background:${tc}"></div>
          <span class="shop-tier-name" style="color:${tc}">${TIER_LABELS[tier]}</span>
          <div class="shop-tier-line" style="background:${tc}22"></div>
        </div>`;

      const cards = tierItems.map(item => {
        const eff       = SHOP_ITEM_EFFECTS[item.id] || {};
        const iconHtml  = SHOP_ITEM_ICONS[item.id]   || '';
        const canAfford = pet.coins >= item.price;
        const isTrying  = tryOnId === item.id;
        const tc2       = eff.tierColor || '#9ca3af';
        const ic        = eff.color || '#a78bfa';

        const priceChip = item.owned
          ? `<div class="shop-price-chip owned-chip">${coinSvg} ${item.price}</div>`
          : `<div class="shop-price-chip ${canAfford ? '' : 'cant-afford'}">${coinSvg} ${item.price}</div>`;

        const action = item.owned
          ? `<button class="shop-equip-btn ${item.equipped ? 'active' : ''}" data-equip="${item.id}">${item.equipped ? 'equipped' : 'equip'}</button>`
          : `<button class="shop-buy-btn" data-buy="${item.id}" ${canAfford ? '' : 'disabled'}>buy</button>`;

        return `
          <div class="shop-card ${item.owned ? 'owned' : ''} ${item.owned && item.equipped ? 'equipped' : ''} ${isTrying ? 'trying' : ''}" data-item="${item.id}">
            <div class="shop-card-art" style="background:linear-gradient(160deg,${tc2}2a 0%,${tc2}08 100%)">
              <div class="shop-tier-badge" style="color:${tc2};border-color:${tc2}55;background:${tc2}18">${TIER_LABELS[tier]}</div>
              ${item.owned && item.equipped ? '<div class="shop-on-badge">on</div>' : ''}
              <div class="shop-art-icon">${iconHtml}</div>
            </div>
            <div class="shop-card-body">
              <div class="shop-item-name">${esc(item.name)}</div>
              <div class="shop-item-eff" style="color:${ic}">${eff.label || ''}</div>
            </div>
            <div class="shop-card-footer">
              ${priceChip}
              ${action}
            </div>
          </div>`;
      });

      return [header, ...cards];
    }).join('');

  } catch(e) { console.error('loadShop:', e); }
}

document.getElementById('shopGrid').addEventListener('click', async e => {
  const buyBtn   = e.target.closest('[data-buy]');
  const equipBtn = e.target.closest('[data-equip]');

  if (buyBtn) {
    const id  = buyBtn.dataset.buy;
    const res = await fetch('/api/shop/buy', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({item_id: id})
    });
    const data = await res.json();
    if (data.error) { showToast(data.error); return; }
    updatePetUI(data.pet);
    if (id === tryOnId) stopTryOn();
    showToast(`got ${id.replace(/_/g,' ')}!`);
    loadShop();
    return;
  }
  if (equipBtn) {
    const id  = equipBtn.dataset.equip;
    const res = await fetch('/api/shop/equip', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({item_id: id})
    });
    const data = await res.json();
    if (data.error) return;
    const shopRes = await fetch('/api/shop');
    const items   = await shopRes.json();
    const eq = new Set(items.filter(i => i.owned && i.equipped).map(i => i.id));
    updateBlobAccessories(eq, tryOnId);
    loadShop();
    return;
  }
  // Tap anywhere on the card = try on / stop trying
  const card = e.target.closest('.shop-card[data-item]');
  if (card) {
    const id = card.dataset.item;
    if (tryOnId === id) stopTryOn(); else tryOnItem(id);
  }
});

document.getElementById('shopTabs')?.addEventListener('click', e => {
  const tab = e.target.closest('.shop-tab');
  if (!tab) return;
  shopCurrentTier = tab.dataset.tier;
  document.querySelectorAll('.shop-tab').forEach(t => t.classList.toggle('active', t === tab));
  loadShop();
});

document.getElementById('tryOnStop').addEventListener('click', stopTryOn);

// ── Settings ──────────────────────────────────────────────────────────────────
document.getElementById('resetBlobBtn').addEventListener('click', () => {
  if (!confirm('Reset your blob bond? Your familiarity will go back to 0.')) return;
  localStats.familiarity = 0;
  localStats.energy      = 60;
  localStats.happiness   = 45;
  saveLocalStats();
  refreshMood();
  showToast('blob bond reset');
  react('welcome');
});

document.getElementById('clearCompletedBtn').addEventListener('click', async () => {
  if (!confirm('Clear all completed tasks?')) return;
  await fetch('/api/settings/clear-completed', { method: 'DELETE' });
  await loadTasks();
  showToast('completed tasks cleared');
});

document.getElementById('resetPetBtn').addEventListener('click', async () => {
  if (!confirm('Reset pet stats (coins, streak, level)?')) return;
  await fetch('/api/settings/reset-pet', { method: 'POST' });
  await loadPet();
  showToast('pet stats reset');
});

// ── Account ───────────────────────────────────────────────────────────────────
// Show the signed-in email under the log-out row.
fetch('/api/auth/me')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    if (d && d.email) {
      const el = document.getElementById('logoutEmail');
      if (el) el.textContent = d.email;
    }
  })
  .catch(() => {});

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', async () => {
  if (!confirm('Log out of your account?')) return;
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  window.location.href = '/login';
});

// ── Cross-device sync ─────────────────────────────────────────────────────────
// Your data lives on the server per account, so it's already shared across
// devices. When you switch back to this tab, pull the latest so changes made on
// another device show up here.
let _lastFocusSync = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - _lastFocusSync > 3000) {
    _lastFocusSync = Date.now();
    Promise.all([loadTasks(), loadPet(), loadHabits(), loadGoals()]).catch(() => {});
  }
});

// ── AI Usage ──────────────────────────────────────────────────────────────────
const USAGE_TYPE_COLORS = {
  chat:               '#a78bfa',
  sentiment:          '#60a5fa',
  nudge:              '#4ade80',
  pet_react:          '#f472b6',
  navigation_analyze: '#fbbf24',
};
const USAGE_TYPE_LABELS = {
  chat:               'chat',
  sentiment:          'sentiment',
  nudge:              'blob nudge',
  pet_react:          'blob react',
  navigation_analyze: 'navigation AI',
};

async function loadUsage() {
  try {
    const data = await fetch('/api/usage').then(r => r.json());
    const t = data.today, a = data.alltime;

    const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    document.getElementById('usageTodayTokens').textContent = fmt(t.total_tokens);
    document.getElementById('usageTodayCalls').textContent  = t.calls;
    document.getElementById('usageTotalTokens').textContent = fmt(a.total_tokens);
    document.getElementById('usageCostEst').textContent     = '$' + a.cost_usd.toFixed(4);

    const breakdown = document.getElementById('usageBreakdown');
    const types = Object.entries(a.by_type).sort((x, y) => y[1].total_tokens - x[1].total_tokens);
    breakdown.innerHTML = types.map(([type, stats]) => {
      const color = USAGE_TYPE_COLORS[type] || '#9ca3af';
      const label = USAGE_TYPE_LABELS[type] || type;
      const pct   = a.total_tokens > 0 ? Math.round(stats.total_tokens / a.total_tokens * 100) : 0;
      return `<div class="usage-row">
        <span class="usage-row-label">
          <span class="usage-row-dot" style="background:${color}"></span>
          ${label}
        </span>
        <span style="display:flex;align-items:center;gap:8px">
          <span style="font-size:10px;color:var(--text-sub)">${stats.calls} calls · ${pct}%</span>
          <span class="usage-row-tokens">${fmt(stats.total_tokens)}</span>
        </span>
      </div>`;
    }).join('');
  } catch(e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOB PHYSICS
// ─────────────────────────────────────────────────────────────────────────────

const blobEl = document.getElementById('blob');
const phone  = document.querySelector('.phone');

let bx = 50, by = 55;
let bvx = 0.15, bvy = 0.12;
let pulseUntil = 0;

// Hero mode: blob flies into the My Blob hero stage
let heroMode = false;
let heroReturnTimer = null;
let heroTargetX = 50, heroTargetY = 35;
let heroScale = 1.0, heroScaleTarget = 1.0;

// Shop preview mode: blob locked into the shop stage, no physics
let shopPreviewMode = false;
let shopTargetX = 50, shopTargetY = 30;

// cursor position in phone-%
let cursorX = 50, cursorY = 50;
let cursorInPhone = false;

phone.addEventListener('mouseenter', () => { cursorInPhone = true; });
phone.addEventListener('mouseleave', () => { cursorInPhone = false; });
phone.addEventListener('mousemove', e => {
  const r  = phone.getBoundingClientRect();
  cursorX  = ((e.clientX - r.left)  / r.width)  * 100;
  cursorY  = ((e.clientY - r.top)   / r.height) * 100;
});

// ── Element edge attraction ───────────────────────────────────────────────────
let attract   = null;
let restTimer = null;

function edgePoint(el, side) {
  const pr = phone.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const toX = v => ((v - pr.left) / pr.width)  * 100;
  const toY = v => ((v - pr.top)  / pr.height) * 100;
  const hw  = (55 / pr.width)  * 100;
  const hh  = (42 / pr.height) * 100;
  const cx  = toX(er.left + er.width  / 2);
  const cy  = toY(er.top  + er.height / 2);
  switch (side) {
    case 'top':    return { x: cx,             y: toY(er.top)    - hh };
    case 'bottom': return { x: cx,             y: toY(er.bottom) + hh };
    case 'left':   return { x: toX(er.left)  - hw, y: cy };
    case 'right':  return { x: toX(er.right) + hw, y: cy };
    default:       return { x: cx, y: cy };
  }
}

function attractToEdge(el, side, ttl = 2000) {
  if (!el) return;
  try {
    const p = edgePoint(el, side);
    if (p.x > 8 && p.x < 92 && p.y > 8 && p.y < 88)
      attract = { ...p, until: performance.now() + ttl };
  } catch (_) {}
}

function scheduleNextRest(delay) {
  clearTimeout(restTimer);
  restTimer = setTimeout(pickRestTarget, delay ?? (3000 + Math.random() * 6000));
}

function pickRestTarget() {
  if (isDragging) { scheduleNextRest(); return; }
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen) { scheduleNextRest(); return; }

  if (tier() === 'terrified' || tier() === 'shy') {
    // Hide at the card edge FARTHEST from cursor
    const cards = Array.from(activeScreen.querySelectorAll('.card, .feed-btn'))
      .filter(el => el.getBoundingClientRect().width > 40);
    if (cards.length) {
      const card  = cards[Math.floor(Math.random() * cards.length)];
      const sides = ['top','bottom','left','right'];
      let bestSide = 'top', bestDist = -Infinity;
      for (const s of sides) {
        const p = edgePoint(card, s);
        const d = Math.hypot(p.x - cursorX, p.y - cursorY);
        if (d > bestDist) { bestDist = d; bestSide = s; }
      }
      attractToEdge(card, bestSide, 4000 + Math.random() * 3000);
      scheduleNextRest();
      return;
    }
  }

  const candidates = Array.from(activeScreen.querySelectorAll(
    '.card, .feed-btn, .stats-row, .menu-row, .add-tile'
  )).filter(el => el.getBoundingClientRect().width > 40);

  if (!candidates.length) { scheduleNextRest(); return; }
  const el   = candidates[Math.floor(Math.random() * candidates.length)];
  const side = ['top','left','right'][Math.floor(Math.random() * 3)];
  attractToEdge(el, side, 3500 + Math.random() * 2500);
  scheduleNextRest();
}

// ── Sticky left dock ─────────────────────────────────────────────────────────
let blobStuckLeft = false;
const STICKY_ENTER_X = 10;   // bx% threshold to snap left
const STICKY_DOCK_X  = 7;    // bx% when docked
const STICKY_EXIT_X  = 18;   // bx% to drag away and unstick

const stickyZoneEl = document.createElement('div');
stickyZoneEl.className = 'blob-sticky-zone';
document.querySelector('.phone').appendChild(stickyZoneEl);

function updateStickyZone() {
  stickyZoneEl.classList.toggle('active', blobStuckLeft);
  stickyZoneEl.classList.toggle('near', !blobStuckLeft && bx < 20);
}

// ── Drag + shake detection ────────────────────────────────────────────────────
let isDragging  = false;
let dragOffX    = 0, dragOffY = 0;
let dragLastX   = 0, dragLastY = 0, dragLastT = 0;
let throwVX     = 0, throwVY  = 0;
let didDrag     = false;
let longPressTimer = null;
let pendingPointerId = null;

// shake detection: count direction reversals during drag
let shakeFlips  = 0;
let lastDragVXSign = 0;
let lastShakeTime  = 0;

function activateDrag(e) {
  isDragging = true;
  blobEl.setPointerCapture(pendingPointerId ?? e.pointerId);
  blobEl.style.cursor = 'grabbing';
  blobEl.style.transform = 'scale(1.12)';
  attract = null; bvx = 0; bvy = 0;
  if (heroMode) exitHeroMode();
}

blobEl.addEventListener('pointerdown', e => {
  const activeScr = document.querySelector('.screen.active');
  if (activeScr && activeScr.id === 'screen-shop') return;
  didDrag    = false;
  shakeFlips = 0;
  pendingPointerId = e.pointerId;

  const pr = phone.getBoundingClientRect();
  dragOffX = e.clientX - pr.left - (bx / 100) * pr.width;
  dragOffY = e.clientY - pr.top  - (by / 100) * pr.height;
  dragLastX = e.clientX; dragLastY = e.clientY; dragLastT = performance.now();
  throwVX = 0; throwVY = 0;

  if (e.pointerType === 'touch') {
    // On mobile: hold for 300ms to start dragging
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      activateDrag(e);
    }, 200);
  } else {
    activateDrag(e);
  }
  e.preventDefault();
});

blobEl.addEventListener('pointermove', e => {
  // Cancel long press if finger moved too much before threshold
  if (longPressTimer && Math.hypot(e.clientX - dragLastX, e.clientY - dragLastY) > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    return;
  }
  if (!isDragging) return;
  const pr  = phone.getBoundingClientRect();
  const now = performance.now();
  const dt  = Math.max(1, now - dragLastT);

  const newX = ((e.clientX - pr.left - dragOffX) / pr.width)  * 100;
  const newY = ((e.clientY - pr.top  - dragOffY) / pr.height) * 100;

  throwVX = (newX - bx) / dt * 14;
  throwVY = (newY - by) / dt * 14;

  // Count horizontal direction reversals → shake
  const vxSign = Math.sign(throwVX);
  if (Math.abs(throwVX) > 0.25 && vxSign !== 0 && vxSign !== lastDragVXSign) {
    shakeFlips++;
    if (shakeFlips >= 6 && Date.now() - lastShakeTime > 1000) {
      lastShakeTime = Date.now();
      shakeFlips    = 0;
      react('shaken');
    }
  }
  lastDragVXSign = vxSign;

  if (Math.hypot(e.clientX - dragLastX, e.clientY - dragLastY) > 4) didDrag = true;

  bx = Math.min(Math.max(newX, 6), 90);
  by = Math.min(Math.max(newY, 8), 88);
  // Unstick if dragged rightward past threshold
  if (blobStuckLeft && bx > STICKY_EXIT_X) { blobStuckLeft = false; updateStickyZone(); }
  dragLastX = e.clientX; dragLastY = e.clientY; dragLastT = now;
});

blobEl.addEventListener('pointerup', () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  isDragging = false;
  pendingPointerId = null;
  blobEl.style.cursor = 'grab';
  blobEl.style.transform = '';
  // Snap to left dock if released near left edge
  if (bx < STICKY_ENTER_X) {
    blobStuckLeft = true;
    bvx = 0; bvy = 0;
    attract = null;
    pulseUntil = performance.now() + 400;
    updateStickyZone();
  } else {
    if (blobStuckLeft && bx > STICKY_EXIT_X) blobStuckLeft = false;
    const cap = 0.85;
    bvx = Math.min(Math.max(throwVX, -cap), cap);
    bvy = Math.min(Math.max(throwVY, -cap), cap);
    pulseUntil = performance.now() + 350;
  }
  scheduleNextRest(2500);
});

blobEl.addEventListener('click', e => {
  if (didDrag) { didDrag = false; return; }
  openChat();
});

// Mobile shake via accelerometer
let lastMobileShake = 0;
window.addEventListener('devicemotion', e => {
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
  if (mag > 22 && Date.now() - lastMobileShake > 1000) {
    lastMobileShake = Date.now();
    react('shaken');
  }
});

// ── Animation loop ────────────────────────────────────────────────────────────
function animateBlob() {
  const now = performance.now();

  if (!isDragging) {
    if (shopPreviewMode) {
      // Recalculate each frame so it stays correct if layout shifts
      const _ss = document.getElementById('shopBlobStage');
      if (_ss) {
        const _pr = phone.getBoundingClientRect();
        const _sr = _ss.getBoundingClientRect();
        if (_sr.height > 0) {
          shopTargetX = ((_sr.left + _sr.width  / 2 - _pr.left) / _pr.width)  * 100;
          shopTargetY = ((_sr.top  + _sr.height / 2 - _pr.top)  / _pr.height) * 100;
        }
      }
      bx += (shopTargetX - bx) * 0.12;
      by += (shopTargetY - by) * 0.12;
      bvx = 0; bvy = 0;
    } else if (heroMode) {
      const _hs = document.getElementById('blobHeroStage');
      if (_hs) {
        const _pr = phone.getBoundingClientRect();
        const _sr = _hs.getBoundingClientRect();
        if (_sr.height > 0) {
          const _cah = _sr.height - 60;
          heroTargetX = ((_sr.left + _sr.width / 2 - _pr.left) / _pr.width) * 100;
          heroTargetY = Math.max(10, Math.min(88, (_sr.top + _cah / 2 - _pr.top) / _pr.height * 100));
        }
      }
      bx  += (heroTargetX - bx)  * 0.09;
      by  += (heroTargetY - by)  * 0.09;
      bvx = 0; bvy = 0;
    } else {
      const f   = localStats.familiarity;
      const spd = localStats.energy < 15 ? 0.3 : 1.0;

      if (attract && now < attract.until) {
        const dx = attract.x - bx;
        const dy = attract.y - by;
        bvx += dx * 0.0015;
        bvy += dy * 0.0014;
      } else if (attract) {
        attract = null;
      }

      if (cursorInPhone && !currentExpression) {
        const dx   = cursorX - bx;
        const dy   = cursorY - by;
        const dist = Math.hypot(dx, dy);
        if (dist < 32 && dist > 0.5) {
          if (f < 42) {
            const strength = f < 20 ? 0.018 : 0.009;
            bvx -= (dx / dist) * strength * (32 - dist);
            bvy -= (dy / dist) * strength * (32 - dist);
            pulseUntil = now + 80;
          } else if (f > 65) {
            const strength = ((f - 65) / 35) * 0.005;
            bvx += (dx / dist) * strength * (32 - dist);
            bvy += (dy / dist) * strength * (32 - dist);
          }
        }
      }

      const noise = localStats.energy < 15 ? 0.002 : 0.009;
      bvx += (Math.random() - 0.5) * noise;
      bvy += (Math.random() - 0.5) * noise;

      const cap = attract ? 0.6 : 0.42;
      bvx = Math.min(Math.max(bvx * 0.991, -cap), cap);
      bvy = Math.min(Math.max(bvy * 0.991, -cap), cap);

      bx += bvx * spd;
      by += bvy * spd;

      // Left sticky dock
      if (blobStuckLeft) {
        bx = STICKY_DOCK_X;
        bvx *= 0.3;
        if (by <  9 || by > 85) { bvy *= -0.65; by = Math.min(Math.max(by, 9), 85); }
      } else {
        if (bx < 13) { bvx *= -0.65; bx = Math.max(bx, 13); pulseUntil = now + 180; }
        if (bx > 87) { bvx *= -0.65; bx = Math.min(bx, 87); pulseUntil = now + 180; }
        if (by <  9 || by > 85) { bvy *= -0.65; by = Math.min(Math.max(by, 9), 85); pulseUntil = now + 180; }
      }
      updateStickyZone();
    }
  }

  heroScale += (heroScaleTarget - heroScale) * 0.1;

  const wobble = (isDragging || heroMode || shopPreviewMode) ? 0 : Math.sin(now / 190) * (localStats.energy < 15 ? 0.8 : 2.3);
  const pulse  = (now < pulseUntil && !heroMode && !shopPreviewMode) ? 1.08 : 1.0;

  blobEl.style.left      = `${bx}%`;
  blobEl.style.top       = `${by}%`;
  blobEl.style.transform = `translate(-50%, -50%) rotate(${wobble}deg) scale(${pulse * heroScale})`;

  weather.draw(now);
  requestAnimationFrame(animateBlob);
}

document.getElementById('bellBtn').addEventListener('click', () => {
  attractToEdge(document.getElementById('bellBtn'), 'bottom', 1200);
  openNotifs();
});

document.getElementById('closeNotifBtn').addEventListener('click', closeNotifs);

document.getElementById('clearNotifsBtn').addEventListener('click', () => {
  saveNotifs([]);
  renderNotifs();
  updateNotifBadge();
});

const notifsToggleEl  = document.getElementById('notifsToggle');
const notifsToggleRow = document.getElementById('notifsToggleRow');

function updateToggleUI() {
  notifsToggleEl.classList.toggle('on', notifsEnabled());
}

notifsToggleRow.addEventListener('click', () => {
  localStorage.setItem(NOTIFS_ENABLED_KEY, notifsEnabled() ? 'false' : 'true');
  updateToggleUI();
  updateNotifBadge();
});

// ── Weather System ────────────────────────────────────────────────────────────
const weather = (() => {
  const canvas = document.getElementById('weatherCanvas');
  const ctx    = canvas.getContext('2d');

  const MOOD_TO_WEATHER = {
    'mood-scared':  'storm',
    'mood-punched': 'storm',
    'mood-dizzy':   'storm',
    'mood-sad':     'rain',
    'mood-sleepy':  'fog',
    'mood-curious': 'cloudy',
    'mood-normal':  'clear',
    'mood-happy':   'sunny',
    'mood-excited': 'sparkle',
  };

  let weatherType  = 'clear';
  let pendingType  = null;
  let displayAlpha = 0;
  let targetAlpha  = 0;
  let fadingOut    = false;

  let drops = [], wisps = [], clouds = [], motes = [], sparkles = [];
  let rayAngle = 0;
  let lightningAlpha = 0, nextLightningAt = 5000, lightningElapsed = 0;
  let lastMoodCheck = 0;

  function resize() {
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }

  function initParticles() {
    const W = canvas.width, H = canvas.height;
    drops  = Array.from({length: 90}, () => ({
      x: Math.random() * W, y: Math.random() * H,
      speed: 5 + Math.random() * 7, len: 9 + Math.random() * 14,
    }));
    wisps  = Array.from({length: 15}, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: 50 + Math.random() * 90,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.15,
      op: 0.025 + Math.random() * 0.04,
    }));
    clouds = Array.from({length: 7}, () => ({
      x: (Math.random() * 1.4 - 0.2) * W, y: 10 + Math.random() * H * 0.30,
      speed: 0.05 + Math.random() * 0.11,
      sc: 0.55 + Math.random() * 1.1, op: 0.05 + Math.random() * 0.07,
    }));
    motes  = Array.from({length: 25}, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: 1 + Math.random() * 2.5,
      vx: (Math.random() - 0.5) * 0.4, vy: -0.3 - Math.random() * 0.5,
      op: 0.12 + Math.random() * 0.28, life: Math.random(),
    }));
  }

  resize();
  initParticles();
  window.addEventListener('resize', () => { resize(); initParticles(); });

  function syncWeather() {
    const mood = getBlobMood();
    const wt   = MOOD_TO_WEATHER[mood] || 'clear';
    if (wt === weatherType && !fadingOut) {
      targetAlpha = wt === 'clear' ? 0 : 1;
      return;
    }
    if (wt !== weatherType && !fadingOut) {
      if (displayAlpha > 0.01) { fadingOut = true; pendingType = wt; targetAlpha = 0; }
      else { weatherType = wt; targetAlpha = wt === 'clear' ? 0 : 1; }
    }
  }

  function drawRain(a, heavy) {
    const W = canvas.width, H = canvas.height;
    const count = heavy ? drops.length : Math.floor(drops.length * 0.55);
    const sm = heavy ? 1.8 : 1;
    ctx.save();
    ctx.strokeStyle = heavy ? `rgba(140,180,255,${a*0.5})` : `rgba(165,205,255,${a*0.35})`;
    ctx.lineWidth = heavy ? 1.2 : 0.8;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const d = drops[i];
      d.y += d.speed * sm; d.x -= d.speed * 0.25 * sm;
      if (d.y > H + 10) { d.y = -10; d.x = Math.random() * W; }
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len * 0.25, d.y - d.len);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawLightning(a, dt) {
    lightningElapsed += dt;
    if (lightningElapsed > nextLightningAt) {
      lightningAlpha = a * 0.55;
      lightningElapsed = 0;
      nextLightningAt = 4000 + Math.random() * 7000;
    }
    if (lightningAlpha > 0.005) {
      ctx.fillStyle = `rgba(180,180,255,${lightningAlpha})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      lightningAlpha *= 0.72;
    }
  }

  function drawFog(a) {
    const W = canvas.width, H = canvas.height;
    for (const w of wisps) {
      w.x += w.vx; w.y += w.vy;
      if (w.x < -w.r)  w.x = W + w.r;
      if (w.x > W+w.r) w.x = -w.r;
      if (w.y < -w.r)  w.y = H + w.r;
      if (w.y > H+w.r) w.y = -w.r;
      const g = ctx.createRadialGradient(w.x, w.y, 0, w.x, w.y, w.r);
      g.addColorStop(0, `rgba(160,160,205,${a*w.op*8})`);
      g.addColorStop(1, `rgba(160,160,205,0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, Math.PI*2); ctx.fill();
    }
    ctx.fillStyle = `rgba(20,20,50,${a*0.07})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawSun(a, bright) {
    const W = canvas.width, H = canvas.height;
    const sx = W * 0.88, sy = -H * 0.03;
    const nRays = 12;
    const innerR = bright ? 28 : 22;
    const outerR = W * (bright ? 1.2 : 0.95);
    const col = bright ? '255,230,100' : '255,210,90';
    rayAngle += 0.0008;
    for (let i = 0; i < nRays; i++) {
      const ang = (i / nRays) * Math.PI * 2 + rayAngle;
      const sp = bright ? 0.07 : 0.055;
      const x2 = sx + Math.cos(ang) * outerR;
      const y2 = sy + Math.sin(ang) * outerR;
      const grad = ctx.createLinearGradient(sx, sy, x2, y2);
      grad.addColorStop(0,   `rgba(${col},${a*(bright?0.28:0.2)})`);
      grad.addColorStop(0.4, `rgba(${col},${a*(bright?0.1:0.07)})`);
      grad.addColorStop(1,   `rgba(${col},0)`);
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(ang-sp)*innerR, sy + Math.sin(ang-sp)*innerR);
      ctx.lineTo(x2, y2);
      ctx.lineTo(sx + Math.cos(ang+sp)*innerR, sy + Math.sin(ang+sp)*innerR);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
    }
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, innerR*3);
    sg.addColorStop(0,   `rgba(${col},${a*0.85})`);
    sg.addColorStop(0.3, `rgba(${col},${a*0.35})`);
    sg.addColorStop(1,   `rgba(${col},0)`);
    ctx.beginPath(); ctx.arc(sx, sy, innerR*3, 0, Math.PI*2);
    ctx.fillStyle = sg; ctx.fill();
    const tg = ctx.createLinearGradient(0, 0, 0, H*0.35);
    tg.addColorStop(0, `rgba(255,190,50,${a*(bright?0.06:0.04)})`);
    tg.addColorStop(1, `rgba(255,190,50,0)`);
    ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H*0.35);
    if (!bright) {
      for (const m of motes) {
        m.life += 0.008; m.x += m.vx; m.y += m.vy;
        if (m.y < -10 || m.x < -5 || m.x > W+5) {
          m.x = Math.random()*W; m.y = H*0.5+Math.random()*H*0.5; m.life = 0;
        }
        const lo = Math.sin(Math.min(m.life*Math.PI, Math.PI));
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI*2);
        ctx.fillStyle = `rgba(255,220,100,${a*m.op*lo})`; ctx.fill();
      }
    }
  }

  function drawSparkles(a) {
    if (Math.random() < 0.12) {
      sparkles.push({
        x: Math.random()*canvas.width,
        y: canvas.height*0.1 + Math.random()*canvas.height*0.65,
        sz: 2 + Math.random()*3, life: 0,
        maxLife: 50 + Math.random()*70,
      });
    }
    for (let i = sparkles.length-1; i >= 0; i--) {
      const s = sparkles[i]; s.life++;
      const half = s.maxLife/2;
      const op = (s.life < half ? s.life/half : (s.maxLife-s.life)/half) * a * 0.75;
      const sz = s.sz * 5;
      ctx.save();
      ctx.strokeStyle = `rgba(255,245,150,${op})`;
      ctx.lineWidth = s.sz*0.4;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y-sz); ctx.lineTo(s.x, s.y+sz);
      ctx.moveTo(s.x-sz, s.y); ctx.lineTo(s.x+sz, s.y);
      ctx.moveTo(s.x-sz*0.5, s.y-sz*0.5); ctx.lineTo(s.x+sz*0.5, s.y+sz*0.5);
      ctx.moveTo(s.x+sz*0.5, s.y-sz*0.5); ctx.lineTo(s.x-sz*0.5, s.y+sz*0.5);
      ctx.stroke(); ctx.restore();
      if (s.life >= s.maxLife) sparkles.splice(i, 1);
    }
  }

  function drawClouds(a) {
    const W = canvas.width;
    // Puffs that make up each cloud, relative to cloud center
    const puffs = [
      { x: 0,   y: 2,   r: 38 },
      { x: 44,  y: -6,  r: 30 },
      { x: -38, y: -2,  r: 27 },
      { x: 18,  y: -20, r: 24 },
      { x: -18, y: -18, r: 20 },
    ];
    for (const c of clouds) {
      c.x += c.speed;
      if (c.x - 210 * c.sc > W) c.x = -210 * c.sc;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(c.sc, c.sc * 0.72);
      for (const p of puffs) {
        const g = ctx.createRadialGradient(
          p.x - p.r * 0.25, p.y - p.r * 0.3, 0,
          p.x, p.y, p.r
        );
        g.addColorStop(0,    `rgba(242,244,255,${a * c.op * 15})`);
        g.addColorStop(0.45, `rgba(225,230,250,${a * c.op * 11})`);
        g.addColorStop(1,    `rgba(205,215,240,0)`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  let lastTs = 0;
  function draw(ts) {
    const dt = ts - lastTs; lastTs = ts;

    if (ts - lastMoodCheck > 800) { syncWeather(); lastMoodCheck = ts; }

    const speed = 0.018;
    if (displayAlpha < targetAlpha)      displayAlpha = Math.min(targetAlpha, displayAlpha + speed);
    else if (displayAlpha > targetAlpha) displayAlpha = Math.max(targetAlpha, displayAlpha - speed);

    if (fadingOut && displayAlpha <= 0.005) {
      fadingOut = false;
      weatherType = pendingType; pendingType = null;
      targetAlpha = weatherType === 'clear' ? 0 : 1;
      displayAlpha = 0;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (displayAlpha < 0.005) return;

    const a = displayAlpha;
    if (weatherType === 'storm') {
      ctx.fillStyle = `rgba(8,4,22,${a*0.28})`; ctx.fillRect(0,0,canvas.width,canvas.height);
      drawRain(a, true); drawLightning(a, dt);
    } else if (weatherType === 'rain')    { drawRain(a, false);
    } else if (weatherType === 'fog')     { drawFog(a);
    } else if (weatherType === 'cloudy')  { drawClouds(a);
    } else if (weatherType === 'sunny')   { drawSun(a, false);
    } else if (weatherType === 'sparkle') { drawSun(a, true); drawSparkles(a); }
  }

  return { draw };
})();

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  blobEl.style.cursor = 'grab';
  refreshMood();
  updateToggleUI();
  updateNotifBadge();
  updateHomeGreeting();

  if (tier() === 'terrified' || tier() === 'shy') {
    bx = 15 + Math.random() * 10;
    by = 20 + Math.random() * 10;
  }

  await Promise.all([loadTasks(), loadPet(), loadHabits(), loadGoals()]);
  // Apply equipped accessories to blob on startup
  fetch('/api/shop').then(r => r.json()).then(items => {
    const eq = new Set(items.filter(i => i.owned && i.equipped).map(i => i.id));
    updateBlobAccessories(eq);
  }).catch(() => {});
  react('welcome');
  requestAnimationFrame(animateBlob);
  scheduleNextRest(2000);
}

init();
