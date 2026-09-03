let state = {
  clips: [],
  clippers: [],
  stats: {},
  settings: {},
  events: [],
  currentTab: 'dashboard',
  selectedClipForPreview: null,
  currentRole: 'c1', // Default to Clipper 1 (never Admin by default)
  isAdminAuthenticated: false,
  selectedMonth: new Date().toISOString().slice(0, 7) // '2026-09'
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  // Check if admin was already authenticated in this session
  if (sessionStorage.getItem('jp_admin_auth') === 'true') {
    state.isAdminAuthenticated = true;
  }

  // Parse URL query parameters for direct links (e.g. ?c=1 or ?clipper=c2 or ?admin=1)
  const urlParams = new URLSearchParams(window.location.search);
  const clipperParam = urlParams.get('c') || urlParams.get('clipper');
  const adminParam = urlParams.get('admin');

  if (adminParam && state.isAdminAuthenticated) {
    state.currentRole = 'admin';
  } else if (clipperParam) {
    const roleKey = clipperParam.startsWith('c') ? clipperParam : `c${clipperParam}`;
    state.currentRole = roleKey;
  } else if (!state.isAdminAuthenticated) {
    state.currentRole = 'c1';
  }

  await Promise.all([
    fetchSettings(),
    fetchClippers(),
    fetchClips(),
    fetchStats(),
    fetchEvents()
  ]);

  populateClipperDropdowns();
  populateMonthDropdown();
  
  // Set role dropdown to active role
  const roleSelect = document.getElementById('user-role-select');
  if (roleSelect) roleSelect.value = state.currentRole;

  applyRoleView(state.currentRole);
  renderAll();
  lucide.createIcons();

  if (adminParam && !state.isAdminAuthenticated) {
    openAdminPinModal();
  }

  const today = new Date().toISOString().split('T')[0];
  const publishInput = document.getElementById('clip-publish-date');
  const checkInput = document.getElementById('clip-check-date');
  if (publishInput) publishInput.value = today;
  if (checkInput) checkInput.value = today;
}

// --- API Calls ---

async function fetchStats() {
  try {
    const monthQuery = state.selectedMonth ? `?month=${state.selectedMonth}` : '';
    const res = await fetch(`/api/stats${monthQuery}`);
    state.stats = await res.json();
    populateMonthDropdown();
    renderStats();
    renderLeaderboard();
    renderPlatformStats();
  } catch (e) {
    console.error('Error fetching stats:', e);
  }
}

async function fetchClips() {
  try {
    const monthQuery = state.selectedMonth ? `?month=${state.selectedMonth}` : '';
    const res = await fetch(`/api/clips${monthQuery}`);
    state.clips = await res.json();
    filterClips();
  } catch (e) {
    console.error('Error fetching clips:', e);
  }
}

function handleMonthChange(newMonth) {
  state.selectedMonth = newMonth;
  fetchStats();
  fetchClips();
}

function getMonthName(ym) {
  if (!ym || ym === 'all') return 'Todos los Meses (Histórico)';
  const [year, month] = ym.split('-');
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const monthName = months[parseInt(month, 10) - 1] || ym;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const isCurrent = ym === currentMonth ? ' (Actual)' : '';
  return `${monthName} ${year}${isCurrent}`;
}

function populateMonthDropdown() {
  const select = document.getElementById('month-filter-select');
  if (!select) return;

  const months = state.stats.availableMonths || [new Date().toISOString().slice(0, 7)];
  
  let html = months.map(m => `
    <option value="${m}" ${state.selectedMonth === m ? 'selected' : ''}>📅 ${getMonthName(m)}</option>
  `).join('');

  html += `<option value="all" ${state.selectedMonth === 'all' ? 'selected' : ''}>📅 Histórico Global (Todos los meses)</option>`;
  select.innerHTML = html;
}

async function fetchClippers() {
  try {
    const res = await fetch('/api/clippers');
    state.clippers = await res.json();
  } catch (e) {
    console.error('Error fetching clippers:', e);
  }
}

async function fetchSettings() {
  try {
    const res = await fetch('/api/settings');
    state.settings = await res.json();
    loadSettingsIntoForm();
  } catch (e) {
    console.error('Error fetching settings:', e);
  }
}

async function fetchEvents() {
  try {
    const res = await fetch('/api/events');
    state.events = await res.json();
    renderEvents();
  } catch (e) {
    console.error('Error fetching events:', e);
  }
}

// --- Auto-Metadata Fetcher ---

async function fetchUrlMetadata(url) {
  if (!url || url.length < 5) return null;

  const spinner = document.getElementById('quick-fetch-spinner');
  if (spinner) spinner.classList.remove('hidden');

  try {
    const res = await fetch('/api/fetch-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();

    if (data.title) {
      const titleInput = document.getElementById('clip-title');
      if (titleInput && (!titleInput.value || titleInput.value.startsWith('Clip de'))) {
        titleInput.value = data.title;
      }
    }

    if (data.views !== undefined && data.views !== null) {
      const viewsInput = document.getElementById('clip-views');
      if (viewsInput) viewsInput.value = data.views;
    }

    if (data.publishDate) {
      const pubInput = document.getElementById('clip-publish-date');
      if (pubInput) pubInput.value = data.publishDate;
    }

    if (data.suggestedCategory) {
      const catSelect = document.getElementById('clip-category');
      if (catSelect) catSelect.value = data.suggestedCategory;
    }

    return data;
  } catch (err) {
    console.error('Error fetching metadata:', err);
    return null;
  } finally {
    if (spinner) spinner.classList.add('hidden');
  }
}

async function handleQuickUrlPaste(e) {
  setTimeout(() => {
    processQuickUrl();
  }, 100);
}

async function processQuickUrl() {
  const input = document.getElementById('quick-url-input');
  const url = (input.value || '').trim();
  if (!url) {
    alert('Por favor pega un enlace de TikTok, Shorts, Reels o X primero.');
    return;
  }

  // Open modal with prefilled data
  openNewClipModal();
  document.getElementById('clip-url').value = url;

  // Auto fetch
  const meta = await fetchUrlMetadata(url);
  if (meta) {
    if (meta.title) document.getElementById('clip-title').value = meta.title;
    if (meta.views) document.getElementById('clip-views').value = meta.views;
    if (meta.suggestedCategory) document.getElementById('clip-category').value = meta.suggestedCategory;
  }
  input.value = '';
}

// --- Roles & Permissions (Admin vs Clipper) ---

function handleRoleChange(newRole) {
  if (newRole === 'admin') {
    if (!state.isAdminAuthenticated) {
      openAdminPinModal();
      return;
    }
  }

  state.currentRole = newRole;
  applyRoleView(newRole);
}

function openAdminPinModal() {
  document.getElementById('pin-modal').classList.remove('hidden');
  document.getElementById('pin-input').value = '';
  document.getElementById('pin-error').classList.add('hidden');
  document.getElementById('pin-input').focus();
}

function cancelAdminPin() {
  document.getElementById('pin-modal').classList.add('hidden');
  // Revert selector
  document.getElementById('user-role-select').value = state.currentRole === 'admin' ? 'c1' : state.currentRole;
}

async function verifyAdminPin(e) {
  e.preventDefault();
  const pin = document.getElementById('pin-input').value;
  try {
    const res = await fetch('/api/auth/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (res.ok) {
      state.isAdminAuthenticated = true;
      sessionStorage.setItem('jp_admin_auth', 'true');
      state.currentRole = 'admin';
      document.getElementById('pin-modal').classList.add('hidden');
      document.getElementById('user-role-select').value = 'admin';
      applyRoleView('admin');
    } else {
      document.getElementById('pin-error').innerText = data.error || 'PIN incorrecto.';
      document.getElementById('pin-error').classList.remove('hidden');
    }
  } catch (err) {
    alert('Error de conexión.');
  }
}

function logoutAdmin() {
  state.isAdminAuthenticated = false;
  sessionStorage.removeItem('jp_admin_auth');
  state.currentRole = 'c1';
  document.getElementById('user-role-select').value = 'c1';
  applyRoleView('c1');
}

function applyRoleView(role) {
  const isAdmin = role === 'admin';
  const mobileBadge = document.getElementById('mobile-role-badge');
  const roleBadge = document.getElementById('welcome-role-badge');
  const roleTitle = document.getElementById('welcome-role-title');

  // Show/Hide Admin-only elements
  document.querySelectorAll('.admin-only').forEach(el => {
    if (isAdmin) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });

  const lockBtn = document.getElementById('admin-lock-btn');
  if (lockBtn) {
    if (isAdmin) lockBtn.classList.remove('hidden');
    else lockBtn.classList.add('hidden');
  }

  if (isAdmin) {
    if (mobileBadge) mobileBadge.innerText = '👑 Admin';
    if (roleBadge) {
      roleBadge.innerText = '👑 Modo Administrador (Jon & Manager)';
      roleBadge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/40';
    }
    if (roleTitle) roleTitle.innerText = 'Panel de Gestión y Control del Equipo de Clippers';

    document.getElementById('kpi-views-title').innerText = 'Vistas Totales Acumuladas';
    document.getElementById('kpi-earned-title').innerText = 'Generado por el Equipo';
    document.getElementById('kpi-pending-title').innerText = 'Pendiente de Pago Total';

    document.getElementById('tab-label-dashboard').innerText = 'Dashboard & Ranking';
    document.getElementById('tab-label-clips').innerText = 'Registro de Clips (Todos)';

    // Show all clippers filter
    const clipperFilter = document.getElementById('filter-clipper');
    if (clipperFilter) {
      clipperFilter.disabled = false;
      clipperFilter.value = '';
    }
  } else {
    // Clipper Specific Portal
    const clipper = state.clippers.find(c => c.id === role) || { name: 'Clipper', role: 'Editor' };
    if (mobileBadge) mobileBadge.innerText = clipper.name;
    if (roleBadge) {
      roleBadge.innerText = `🎬 Portal de Clipper: ${clipper.name}`;
      roleBadge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-brand-kick/20 text-brand-kick border border-brand-kick/40';
    }
    if (roleTitle) roleTitle.innerText = `👋 ¡Hola, ${clipper.name}! Sube tus nuevos enlaces aquí`;

    document.getElementById('kpi-views-title').innerText = 'Tus Vistas Totales';
    document.getElementById('kpi-earned-title').innerText = 'Tu Saldo Ganado';
    document.getElementById('kpi-pending-title').innerText = 'Tu Saldo Pendiente de Cobro';

    document.getElementById('tab-label-dashboard').innerText = 'Tu Rendimiento';
    document.getElementById('tab-label-clips').innerText = 'Tus Clips Subidos';

    // Lock clipper filter in clips tab
    const clipperFilter = document.getElementById('filter-clipper');
    if (clipperFilter) {
      clipperFilter.value = role;
      clipperFilter.disabled = true;
    }

    // If currently on admin-only tabs, redirect to dashboard
    if (state.currentTab === 'payouts' || state.currentTab === 'settings') {
      switchTab('dashboard');
    }
  }

  renderStats();
  filterClips();
  lucide.createIcons();
}

// --- Tab Navigation ---

function switchTab(tabId) {
  state.currentTab = tabId;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active', 'text-brand-kick', 'bg-brand-kick/10', 'border-brand-kick/30');
    btn.classList.add('text-slate-400', 'border-transparent');
  });

  const activeBtn = document.getElementById(`tab-btn-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.add('active', 'text-brand-kick', 'bg-brand-kick/10', 'border-brand-kick/30');
    activeBtn.classList.remove('text-slate-400', 'border-transparent');
  }

  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.add('hidden');
  });

  const activeContent = document.getElementById(`tab-${tabId}`);
  if (activeContent) {
    activeContent.classList.remove('hidden');
  }

  if (tabId === 'payouts') {
    renderPayoutsGrid();
  }
  if (tabId === 'dashboard') {
    fetchStats();
  }

  lucide.createIcons();
}

// --- Render Functions ---

function renderAll() {
  renderStats();
  renderLeaderboard();
  renderPayoutsGrid();
  renderTeamGrid();
  renderEvents();
  renderPlatformStats();
  filterClips();
}

function formatNumber(num) {
  return new Intl.NumberFormat('es-ES').format(num || 0);
}

function renderStats() {
  const s = state.stats || {};
  const isClipper = state.currentRole !== 'admin';

  if (isClipper) {
    const list = s.leaderboard || [];
    const cStat = list.find(c => c.id === state.currentRole) || { totalViews: 0, totalEarned: 0, pendingPayout: 0, qualifiedClips: 0, clipsCount: 0 };
    document.getElementById('stat-total-views').innerText = formatNumber(cStat.totalViews);
    document.getElementById('stat-total-earned').innerText = `$${formatNumber(cStat.totalEarned)}`;
    document.getElementById('stat-pending-payout').innerText = `$${formatNumber(cStat.pendingPayout)}`;
    document.getElementById('stat-qualified-clips').innerText = formatNumber(cStat.qualifiedClips);
    document.getElementById('stat-total-clips').innerText = formatNumber(cStat.clipsCount);
  } else {
    document.getElementById('stat-total-views').innerText = formatNumber(s.totalViews);
    document.getElementById('stat-total-earned').innerText = `$${formatNumber(s.totalEarned)}`;
    document.getElementById('stat-pending-payout').innerText = `$${formatNumber(s.totalPendingPayout)}`;
    document.getElementById('stat-qualified-clips').innerText = formatNumber(s.qualifiedClips);
    document.getElementById('stat-total-clips').innerText = formatNumber(s.totalClips);
  }
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboard-tbody');
  if (!tbody) return;

  const list = state.stats.leaderboard || [];
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-500">No hay datos aún. Sube el primer clip para empezar.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((c, idx) => {
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
    const isMe = state.currentRole === c.id;
    return `
      <tr class="hover:bg-slate-800/40 transition-colors ${isMe ? 'bg-brand-kick/10 border-l-2 border-brand-kick' : ''}">
        <td class="p-3.5 text-center font-bold text-sm whitespace-nowrap ${idx === 0 ? 'text-amber-400' : 'text-slate-400'}">${medal}</td>
        <td class="p-3.5 whitespace-nowrap">
          <div class="font-bold text-white text-xs flex items-center justify-between gap-2">
            <span>${c.name} ${isMe ? '<span class="text-[10px] bg-brand-kick text-black font-extrabold px-1.5 py-0.2 rounded ml-1">TÚ</span>' : ''}</span>
            ${state.currentRole === 'admin' ? `
              <button onclick="openEditClipperModal('${c.id}')" class="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-brand-kick" title="Modificar Perfil del Clipper">
                <i data-lucide="edit" class="size-3"></i>
              </button>
            ` : ''}
          </div>
          <div class="text-[11px] text-slate-500 font-mono">${c.handle || ''}</div>
        </td>
        <td class="p-3.5 text-slate-300 whitespace-nowrap">${c.role || '-'}</td>
        <td class="p-3.5 text-right font-semibold text-purple-400 whitespace-nowrap">${c.qualifiedClips} <span class="text-slate-500 text-[10px]">(${c.clipsCount} tot.)</span></td>
        <td class="p-3.5 text-right font-black text-white whitespace-nowrap">${formatNumber(c.totalViews)}</td>
        <td class="p-3.5 text-right font-black text-emerald-400 whitespace-nowrap">$${c.totalEarned}</td>
        <td class="p-3.5 text-right font-bold whitespace-nowrap ${c.pendingPayout > 0 ? 'text-amber-400' : 'text-slate-500'}">$${c.pendingPayout}</td>
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

function renderPlatformStats() {
  const container = document.getElementById('platform-stats-container');
  if (!container) return;

  const platformCounts = { tiktok: 0, facebook: 0, youtube: 0, instagram: 0, twitter: 0 };
  state.clips.forEach(c => {
    if (platformCounts[c.platform] !== undefined) {
      platformCounts[c.platform] += c.views || 0;
    }
  });

  const totalPlatformViews = Object.values(platformCounts).reduce((a, b) => a + b, 0) || 1;

  const platforms = [
    { key: 'tiktok', name: 'TikTok', color: 'bg-cyan-400', icon: 'music', views: platformCounts.tiktok },
    { key: 'facebook', name: 'Facebook Reels', color: 'bg-blue-500', icon: 'facebook', views: platformCounts.facebook },
    { key: 'youtube', name: 'YouTube Shorts', color: 'bg-red-500', icon: 'youtube', views: platformCounts.youtube },
    { key: 'instagram', name: 'Instagram Reels', color: 'bg-pink-500', icon: 'camera', views: platformCounts.instagram }
  ];

  container.innerHTML = platforms.map(p => {
    const pct = Math.round((p.views / totalPlatformViews) * 100);
    return `
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-slate-300 font-semibold flex items-center gap-1.5">
            <i data-lucide="${p.icon}" class="size-3.5"></i> ${p.name}
          </span>
          <span class="text-slate-400 font-mono">${formatNumber(p.views)} views (${pct}%)</span>
        </div>
        <div class="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
          <div class="h-full ${p.color}" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

function renderClipsTable(clips) {
  const tbody = document.getElementById('clips-tbody');
  const countBadge = document.getElementById('clips-count-badge');
  if (!tbody) return;

  if (countBadge) countBadge.innerText = `${clips.length} clips encontrados`;

  if (clips.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="p-8 text-center text-slate-500">No se encontraron clips registrados.</td></tr>`;
    return;
  }

  const isAdmin = state.currentRole === 'admin';

  tbody.innerHTML = clips.map(clip => {
    const platformIcon = getPlatformBadge(clip.platform);
    const statusBadge = getStatusBadge(clip.status);
    const tierBadgeClass = getTierClass(clip.badge);

    return `
      <tr class="hover:bg-slate-800/40 transition-colors group">
        <!-- Preview Icon Button -->
        <td class="p-3.5 whitespace-nowrap text-center">
          <button onclick="openPreviewModal('${clip.id}')" class="size-9 rounded-xl bg-slate-900 border border-slate-700 hover:border-brand-kick hover:text-brand-kick text-slate-300 inline-flex items-center justify-center transition-all shadow-sm active:scale-95" title="Previsualizar Video">
            <i data-lucide="play" class="size-4"></i>
          </button>
        </td>

        <!-- Clipper -->
        <td class="p-3.5 whitespace-nowrap">
          <div class="font-bold text-white text-xs">${clip.clipperName}</div>
          <span class="text-[10px] text-slate-400 font-mono">${clip.clipperId}</span>
        </td>

        <!-- Title & Category -->
        <td class="p-3.5 min-w-[200px] max-w-sm">
          <div class="font-bold text-slate-100 truncate cursor-pointer hover:text-brand-kick" onclick="openPreviewModal('${clip.id}')" title="${clip.title || ''}">${clip.title || 'Sin título'}</div>
          <span class="inline-block mt-1 px-2 py-0.5 rounded text-[10px] bg-slate-900 text-slate-400 border border-white/5 whitespace-nowrap">${clip.category || 'General'}</span>
        </td>

        <!-- Platform -->
        <td class="p-3.5 whitespace-nowrap">
          ${platformIcon}
        </td>

        <!-- Views -->
        <td class="p-3.5 text-right font-black text-sm text-white whitespace-nowrap">
          ${formatNumber(clip.views)}
        </td>

        <!-- Tier -->
        <td class="p-3.5 text-center whitespace-nowrap">
          <span class="inline-flex items-center whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-bold ${tierBadgeClass}">
            ${clip.tierLabel || 'En progreso (< 10K)'}
          </span>
        </td>

        <!-- Remuneration -->
        <td class="p-3.5 text-right font-black text-sm text-emerald-400 whitespace-nowrap">
          $${clip.payout || 0} USD
        </td>

        <!-- Dates -->
        <td class="p-3.5 text-xs text-slate-400 whitespace-nowrap">
          <div>Pub: <span class="text-slate-300 font-mono">${clip.publishDate || '-'}</span></div>
          <div class="mt-0.5">Corte: <span class="text-slate-300 font-mono">${clip.checkDate || '-'}</span></div>
        </td>

        <!-- Status -->
        <td class="p-3.5 text-center whitespace-nowrap">
          ${statusBadge}
        </td>

        <!-- Actions -->
        <td class="p-3.5 text-right whitespace-nowrap">
          <div class="flex items-center justify-end gap-1.5">
            <button onclick="openEditClipModal('${clip.id}')" class="p-2 rounded-lg bg-slate-900 border border-slate-700/80 hover:bg-slate-800 hover:border-slate-500 text-slate-300 hover:text-white transition-all shadow-sm" title="Editar Métricas">
              <i data-lucide="edit-3" class="size-3.5"></i>
            </button>
            ${isAdmin ? `
              <button onclick="toggleClipPaidStatus('${clip.id}')" class="p-2 rounded-lg ${clip.status === 'paid' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-900 border border-slate-700/80 hover:bg-emerald-500/20 hover:border-emerald-500/30 text-slate-400 hover:text-emerald-400'} transition-all shadow-sm" title="${clip.status === 'paid' ? 'Marcar Pendiente' : 'Marcar Pagado'}">
                <i data-lucide="dollar-sign" class="size-3.5"></i>
              </button>
              <button onclick="deleteClip('${clip.id}')" class="p-2 rounded-lg bg-slate-900 border border-slate-700/80 hover:bg-red-500/20 hover:border-red-500/30 text-slate-400 hover:text-red-400 transition-all shadow-sm" title="Eliminar">
                <i data-lucide="trash-2" class="size-3.5"></i>
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

function renderPayoutsGrid() {
  const container = document.getElementById('clippers-payout-grid');
  if (!container) return;

  const stats = state.stats.leaderboard || [];

  container.innerHTML = state.clippers.map(clipper => {
    const cStat = stats.find(s => s.id === clipper.id) || {
      clipsCount: 0,
      qualifiedClips: 0,
      totalViews: 0,
      totalEarned: 0,
      pendingPayout: 0,
      paidAmount: 0
    };

    return `
      <div class="glass-card rounded-2xl p-6 space-y-5 border border-white/5 relative overflow-hidden flex flex-col justify-between">
        <!-- Clipper Header -->
        <div class="flex items-start justify-between">
          <div>
            <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-brand-kick bg-brand-kick/10 px-2 py-0.5 rounded-md border border-brand-kick/20">${clipper.handle || '@clipper'}</span>
            <h3 class="font-bold text-lg text-white mt-1">${clipper.name}</h3>
            <p class="text-xs text-slate-400">${clipper.role || 'Editor de Contenido'}</p>
          </div>
          <div class="flex items-center gap-1.5">
            ${isAdmin ? `
              <button onclick="openEditClipperModal('${clipper.id}')" class="p-2 rounded-xl bg-slate-900 border border-slate-700 hover:border-brand-kick hover:text-brand-kick text-slate-300 transition-all" title="Modificar Perfil del Clipper">
                <i data-lucide="edit" class="size-4"></i>
              </button>
            ` : ''}
            <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-400">
              <i data-lucide="user" class="size-4"></i>
            </div>
          </div>
        </div>

        <!-- Metrics Box -->
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div class="p-3 rounded-xl bg-slate-900/80 border border-white/5">
            <span class="text-slate-400 text-[11px]">Vistas Totales</span>
            <div class="font-black text-white text-base mt-0.5">${formatNumber(cStat.totalViews)}</div>
          </div>
          <div class="p-3 rounded-xl bg-slate-900/80 border border-white/5">
            <span class="text-slate-400 text-[11px]">Clips ≥10K</span>
            <div class="font-black text-purple-400 text-base mt-0.5">${cStat.qualifiedClips} <span class="text-slate-500 text-xs font-normal">/ ${cStat.clipsCount}</span></div>
          </div>
        </div>

        <!-- Balance Highlights -->
        <div class="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2 text-xs">
          <div class="flex justify-between items-center">
            <span class="text-slate-400">Total Ganado:</span>
            <span class="font-bold text-white text-sm">$${cStat.totalEarned} USD</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-slate-400">Ya Pagado:</span>
            <span class="font-semibold text-slate-300">$${cStat.paidAmount} USD</span>
          </div>
          <div class="flex justify-between items-center pt-2 border-t border-white/5">
            <span class="font-bold text-amber-400">Pendiente de Pago:</span>
            <span class="font-black text-base text-amber-400">$${cStat.pendingPayout} USD</span>
          </div>
        </div>

        <!-- Payout Action Button -->
        <div class="pt-2">
          ${cStat.pendingPayout > 0 ? `
            <button onclick="payoutClipper('${clipper.id}', '${clipper.name}', ${cStat.pendingPayout})" class="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-black font-bold text-xs shadow-lg shadow-emerald-500/20 transition-all flex items-center justify-center gap-2">
              <i data-lucide="check-check" class="size-4"></i> Liquidar y Pagar $${cStat.pendingPayout} USD
            </button>
          ` : `
            <div class="w-full py-2 px-4 rounded-xl bg-slate-900 border border-slate-800 text-slate-500 font-semibold text-xs text-center flex items-center justify-center gap-1.5">
              <i data-lucide="check" class="size-3.5 text-emerald-400"></i> Al día (Sin pagos pendientes)
            </div>
          `}
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

function renderEvents() {
  const container = document.getElementById('events-container');
  if (!container) return;

  if (state.events.length === 0) {
    container.innerHTML = `<div class="col-span-2 p-8 text-center text-slate-500 glass-card rounded-2xl">No hay eventos asignados. Añade el primer partido o directo.</div>`;
    return;
  }

  const isAdmin = state.currentRole === 'admin';

  container.innerHTML = state.events.map(ev => `
    <div class="glass-card rounded-2xl p-5 space-y-3 border border-white/5">
      <div class="flex items-start justify-between">
        <div>
          <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-brand-kick/10 text-brand-kick border border-brand-kick/20">${ev.streamType || 'Stream Kick'}</span>
          <h4 class="font-bold text-white text-sm mt-1.5">${ev.title}</h4>
        </div>
        ${isAdmin ? `
          <button onclick="deleteEvent('${ev.id}')" class="text-slate-500 hover:text-red-400 p-1">
            <i data-lucide="trash" class="size-4"></i>
          </button>
        ` : ''}
      </div>

      <div class="grid grid-cols-2 gap-2 text-xs text-slate-300">
        <div class="flex items-center gap-1.5"><i data-lucide="calendar" class="size-3.5 text-slate-400"></i> ${ev.date}</div>
        <div class="flex items-center gap-1.5"><i data-lucide="clock" class="size-3.5 text-slate-400"></i> ${ev.time || '20:00 CEST'}</div>
      </div>

      <div class="pt-2 border-t border-white/5 flex items-center justify-between text-xs">
        <span class="text-slate-400">Asignado a:</span>
        <span class="font-bold text-brand-kick">${ev.assignedTo}</span>
      </div>
    </div>
  `).join('');

  lucide.createIcons();
}

// --- Helpers & Badges ---

function getPlatformBadge(platform) {
  switch (platform) {
    case 'tiktok':
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"><i data-lucide="music" class="size-3.5"></i> TikTok</span>`;
    case 'facebook':
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20"><i data-lucide="facebook" class="size-3.5"></i> Facebook</span>`;
    case 'youtube':
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20"><i data-lucide="youtube" class="size-3.5"></i> YouTube</span>`;
    case 'instagram':
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-pink-500/10 text-pink-400 border border-pink-500/20"><i data-lucide="camera" class="size-3.5"></i> Reels</span>`;
    case 'twitter':
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-500/10 text-slate-300 border border-slate-500/20"><i data-lucide="twitter" class="size-3.5"></i> X</span>`;
    default:
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 text-slate-400">Otro</span>`;
  }
}

function getStatusBadge(status) {
  switch (status) {
    case 'paid':
      return `<span class="inline-flex items-center whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">💸 Pagado</span>`;
    case 'approved':
      return `<span class="inline-flex items-center whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20">✅ Aprobado</span>`;
    default:
      return `<span class="inline-flex items-center whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">⏳ Pendiente</span>`;
  }
}

function getTierClass(badge) {
  switch (badge) {
    case 'tier-1': return 'badge-tier-1';
    case 'tier-2': return 'badge-tier-2';
    case 'tier-3': return 'badge-tier-3';
    case 'tier-4': return 'badge-tier-4';
    case 'tier-5': return 'badge-tier-5';
    default: return 'badge-tier-0';
  }
}

function populateClipperDropdowns() {
  const selectModal = document.getElementById('clip-clipper-id');
  const selectFilter = document.getElementById('filter-clipper');

  if (selectModal) {
    selectModal.innerHTML = state.clippers.map(c => `
      <option value="${c.id}">${c.name} (${c.handle || ''})</option>
    `).join('');
  }

  if (selectFilter) {
    selectFilter.innerHTML = `<option value="">Todos los Clippers</option>` + state.clippers.map(c => `
      <option value="${c.id}">${c.name}</option>
    `).join('');
  }
}

// --- Video Preview Engine ---

function openPreviewModal(clipId) {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;

  state.selectedClipForPreview = clip;

  document.getElementById('preview-title').innerText = clip.title || 'Clip sin título';
  document.getElementById('preview-clipper').innerText = clip.clipperName;
  document.getElementById('preview-category').innerText = clip.category || 'General';
  document.getElementById('preview-publish-date').innerText = clip.publishDate || '-';
  document.getElementById('preview-check-date').innerText = clip.checkDate || '-';
  document.getElementById('preview-views').innerText = formatNumber(clip.views);
  document.getElementById('preview-payout').innerText = `$${clip.payout || 0} USD`;
  document.getElementById('preview-status').innerText = clip.status === 'paid' ? 'Pagado / Liquidado' : clip.status === 'approved' ? 'Aprobado para Pago' : 'Pendiente';
  document.getElementById('preview-notes').innerText = clip.notes || 'Sin notas adicionales.';

  const directLink = document.getElementById('preview-direct-link');
  if (directLink) directLink.href = clip.url;

  const tierBadge = document.getElementById('preview-tier-badge');
  if (tierBadge) {
    tierBadge.className = `px-3 py-1.5 rounded-xl font-bold text-center ${getTierClass(clip.badge)}`;
    tierBadge.innerText = clip.tierLabel || 'En progreso';
  }

  const editBtn = document.getElementById('preview-edit-btn');
  if (editBtn) {
    editBtn.onclick = () => {
      closePreviewModal();
      openEditClipModal(clip.id);
    };
  }

  const playerContainer = document.getElementById('preview-player-container');
  const embedInfo = clip.embedInfo || {};

  if (clip.platform === 'youtube' && embedInfo.embedUrl) {
    playerContainer.innerHTML = `
      <iframe src="${embedInfo.embedUrl}" title="YouTube Short Preview" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
    `;
  } else if (clip.platform === 'tiktok') {
    playerContainer.innerHTML = `
      <div class="p-6 text-center space-y-4">
        <div class="size-16 rounded-2xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 mx-auto flex items-center justify-center">
          <i data-lucide="music" class="size-8"></i>
        </div>
        <h4 class="font-bold text-white text-sm">TikTok Video</h4>
        <p class="text-xs text-slate-400">Por políticas de seguridad de TikTok, puedes visualizarlo directamente en la aplicación.</p>
        <a href="${clip.url}" target="_blank" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 text-black font-bold text-xs hover:bg-cyan-300">
          <i data-lucide="external-link" class="size-3.5"></i> Abrir en TikTok
        </a>
      </div>
    `;
  } else if (clip.platform === 'instagram' && embedInfo.embedUrl) {
    playerContainer.innerHTML = `
      <iframe src="${embedInfo.embedUrl}" title="Instagram Reel Preview" frameborder="0" scrolling="no" allowtransparency="true"></iframe>
    `;
  } else {
    playerContainer.innerHTML = `
      <div class="p-6 text-center space-y-4">
        <div class="size-16 rounded-2xl bg-slate-800 text-slate-300 mx-auto flex items-center justify-center">
          <i data-lucide="film" class="size-8"></i>
        </div>
        <h4 class="font-bold text-white text-sm">Enlace Directo del Video</h4>
        <p class="text-xs text-slate-400">${clip.url}</p>
        <a href="${clip.url}" target="_blank" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-kick text-black font-bold text-xs hover:bg-brand-kickHover">
          <i data-lucide="external-link" class="size-3.5"></i> Ver Video
        </a>
      </div>
    `;
  }

  document.getElementById('preview-modal').classList.remove('hidden');
  lucide.createIcons();
}

function closePreviewModal() {
  const container = document.getElementById('preview-player-container');
  if (container) container.innerHTML = '';
  document.getElementById('preview-modal').classList.add('hidden');
}

// --- Clip Modal (New / Edit) ---

function openNewClipModal() {
  document.getElementById('modal-title').innerHTML = `<i data-lucide="video" class="size-5 text-brand-kick"></i> Subir Enlace de Clip`;
  document.getElementById('clip-id').value = '';
  document.getElementById('clip-url').value = '';
  document.getElementById('clip-title').value = '';
  document.getElementById('clip-views').value = '';
  document.getElementById('clip-notes').value = '';
  document.getElementById('clip-status').value = 'pending';

  // If in clipper role, default to that clipper
  if (state.currentRole !== 'admin') {
    document.getElementById('clip-clipper-id').value = state.currentRole;
  }

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('clip-publish-date').value = today;
  document.getElementById('clip-check-date').value = today;

  document.getElementById('clip-modal').classList.remove('hidden');
  lucide.createIcons();
}

function openEditClipModal(clipId) {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;

  document.getElementById('modal-title').innerHTML = `<i data-lucide="edit-3" class="size-5 text-brand-kick"></i> Editar Métricas de Clip`;
  document.getElementById('clip-id').value = clip.id;
  document.getElementById('clip-clipper-id').value = clip.clipperId;
  document.getElementById('clip-url').value = clip.url;
  document.getElementById('clip-title').value = clip.title || '';
  document.getElementById('clip-category').value = clip.category || 'Pick Verde';
  document.getElementById('clip-views').value = clip.views || 0;
  document.getElementById('clip-publish-date').value = clip.publishDate || '';
  document.getElementById('clip-check-date').value = clip.checkDate || '';
  document.getElementById('clip-status').value = clip.status || 'pending';
  document.getElementById('clip-notes').value = clip.notes || '';

  document.getElementById('clip-modal').classList.remove('hidden');
  lucide.createIcons();
}

function closeClipModal() {
  document.getElementById('clip-modal').classList.add('hidden');
}

async function handleClipSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('clip-id').value;
  const payload = {
    clipperId: document.getElementById('clip-clipper-id').value,
    url: document.getElementById('clip-url').value,
    title: document.getElementById('clip-title').value,
    category: document.getElementById('clip-category').value,
    views: parseInt(document.getElementById('clip-views').value) || 0,
    publishDate: document.getElementById('clip-publish-date').value,
    checkDate: document.getElementById('clip-check-date').value,
    status: document.getElementById('clip-status').value,
    notes: document.getElementById('clip-notes').value
  };

  try {
    if (id) {
      await fetch(`/api/clips/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    closeClipModal();
    await Promise.all([fetchClips(), fetchStats()]);
  } catch (err) {
    alert('Error al guardar clip: ' + err.message);
  }
}

async function toggleClipPaidStatus(clipId) {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;

  const newStatus = clip.status === 'paid' ? 'pending' : 'paid';

  try {
    await fetch(`/api/clips/${clipId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    await Promise.all([fetchClips(), fetchStats()]);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteClip(clipId) {
  if (!confirm('¿Estás seguro de eliminar este clip?')) return;

  try {
    await fetch(`/api/clips/${clipId}`, { method: 'DELETE' });
    await Promise.all([fetchClips(), fetchStats()]);
  } catch (err) {
    alert('Error al eliminar: ' + err.message);
  }
}

// --- Payout Bulk Actions ---

async function payoutClipper(clipperId, clipperName, amount) {
  if (!confirm(`¿Confirmas la liquidación de $${amount} USD para ${clipperName}? Todos sus clips pendientes pasarán a estado PAGADO.`)) return;

  try {
    const res = await fetch(`/api/clippers/${clipperId}/payout`, { method: 'POST' });
    const data = await res.json();
    alert(`✅ Liquidación completada: Se marcaron ${data.paidCount} clips como PAGADOS ($${data.paidSum} USD).`);
    await Promise.all([fetchClips(), fetchStats()]);
    renderPayoutsGrid();
  } catch (err) {
    alert('Error al liquidar: ' + err.message);
  }
}

// --- Filter Clips ---

function filterClips() {
  const search = (document.getElementById('clips-search').value || '').toLowerCase();
  const platform = document.getElementById('filter-platform').value;
  const status = document.getElementById('filter-status').value;

  // Active role filter
  const targetClipperId = state.currentRole !== 'admin' ? state.currentRole : document.getElementById('filter-clipper').value;

  let filtered = state.clips;

  if (targetClipperId) {
    filtered = filtered.filter(c => c.clipperId === targetClipperId);
  }
  if (platform) {
    filtered = filtered.filter(c => c.platform === platform);
  }
  if (status) {
    filtered = filtered.filter(c => c.status === status);
  }
  if (search) {
    filtered = filtered.filter(c =>
      (c.title && c.title.toLowerCase().includes(search)) ||
      (c.clipperName && c.clipperName.toLowerCase().includes(search)) ||
      (c.category && c.category.toLowerCase().includes(search)) ||
      (c.url && c.url.toLowerCase().includes(search))
    );
  }

  renderClipsTable(filtered);
}

// --- Event Planner ---

function openNewEventModal() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('event-date').value = today;
  document.getElementById('event-modal').classList.remove('hidden');
}

function closeEventModal() {
  document.getElementById('event-modal').classList.add('hidden');
}

async function handleEventSubmit(e) {
  e.preventDefault();
  const payload = {
    title: document.getElementById('event-title').value,
    date: document.getElementById('event-date').value,
    time: document.getElementById('event-time').value,
    assignedTo: document.getElementById('event-assigned').value,
    streamType: document.getElementById('event-type').value
  };

  try {
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    closeEventModal();
    await fetchEvents();
  } catch (err) {
    alert('Error al guardar evento: ' + err.message);
  }
}

async function deleteEvent(eventId) {
  if (!confirm('¿Eliminar este evento programado?')) return;
  try {
    await fetch(`/api/events/${eventId}`, { method: 'DELETE' });
    await fetchEvents();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// --- Settings & Tiers ---

function loadSettingsIntoForm() {
  const tiers = state.settings.payoutTiers || [];
  const t1 = tiers.find(t => t.minViews === 10000);
  const t2 = tiers.find(t => t.minViews === 50000);
  const t3 = tiers.find(t => t.minViews === 100000);
  const t4 = tiers.find(t => t.minViews === 500000);

  if (t1) document.getElementById('tier-1-payout').value = t1.payout;
  if (t2) document.getElementById('tier-2-payout').value = t2.payout;
  if (t3) document.getElementById('tier-3-payout').value = t3.payout;
  if (t4) document.getElementById('tier-4-payout').value = t4.payout;
  if (document.getElementById('admin-pin-input')) {
    document.getElementById('admin-pin-input').value = state.settings.adminPin || '1234';
  }
}

async function saveSettings(e) {
  e.preventDefault();

  const p1 = parseFloat(document.getElementById('tier-1-payout').value) || 5;
  const p2 = parseFloat(document.getElementById('tier-2-payout').value) || 25;
  const p3 = parseFloat(document.getElementById('tier-3-payout').value) || 40;
  const p4 = parseFloat(document.getElementById('tier-4-payout').value) || 120;
  const adminPin = document.getElementById('admin-pin-input').value || '1234';

  const newTiers = [
    { minViews: 10000, maxViews: 49999, payout: p1, label: `🥉 Nivel 1 (10K+ Views)`, badge: "tier-1" },
    { minViews: 50000, maxViews: 99999, payout: p2, label: `🥈 Nivel 2 (50K+ Views)`, badge: "tier-2" },
    { minViews: 100000, maxViews: 499999, payout: p3, label: `🥇 Nivel 3 (100K+ Views)`, badge: "tier-3" },
    { minViews: 500000, maxViews: 999999, payout: p4, label: `💎 Nivel Master (500K+ Views)`, badge: "tier-4" },
    { minViews: 1000000, maxViews: null, payout: p4 * 2, label: `👑 Nivel Viral Legend (1M+ Views)`, badge: "tier-5" }
  ];

  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payoutTiers: newTiers, adminPin })
    });
    alert('✅ Tarifas y PIN de Administrador guardados con éxito.');
    await Promise.all([fetchSettings(), fetchClips(), fetchStats()]);
  } catch (err) {
    alert('Error al guardar ajustes: ' + err.message);
  }
}

// --- CSV Export ---

function exportCSV() {
  window.open('/api/export/csv', '_blank');
}

// --- Clipper Profile Management ---

function openEditClipperModal(clipperId) {
  const clipper = state.clippers.find(c => c.id === clipperId);
  if (!clipper) return;

  document.getElementById('edit-clipper-id').value = clipper.id;
  document.getElementById('edit-clipper-name').value = clipper.name || '';
  document.getElementById('edit-clipper-handle').value = clipper.handle || '';
  document.getElementById('edit-clipper-role').value = clipper.role || '';
  document.getElementById('edit-clipper-active').checked = clipper.active !== false;

  document.getElementById('edit-clipper-modal').classList.remove('hidden');
  lucide.createIcons();
}

function closeEditClipperModal() {
  document.getElementById('edit-clipper-modal').classList.add('hidden');
}

async function handleSaveClipperProfile(e) {
  e.preventDefault();
  const id = document.getElementById('edit-clipper-id').value;
  const name = document.getElementById('edit-clipper-name').value.trim();
  const handle = document.getElementById('edit-clipper-handle').value.trim();
  const role = document.getElementById('edit-clipper-role').value.trim();
  const active = document.getElementById('edit-clipper-active').checked;

  try {
    const res = await fetch(`/api/clippers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, handle, role, active })
    });

    if (res.ok) {
      closeEditClipperModal();
      await Promise.all([fetchClippers(), fetchClips(), fetchStats()]);
      populateClipperDropdowns();
      applyRoleView(state.currentRole);
      renderAll();
      alert('✅ Perfil del Clipper actualizado con éxito.');
    } else {
      alert('Error al actualizar el clipper.');
    }
  } catch (err) {
    alert('Error de conexión: ' + err.message);
  }
}

function renderTeamGrid() {
  const container = document.getElementById('clippers-team-grid');
  if (!container) return;

  const currentOrigin = window.location.origin;

  container.innerHTML = state.clippers.map((clipper, index) => {
    const directLink = `${currentOrigin}/?c=${clipper.id.replace('c', '')}`;
    const isActive = clipper.active !== false;

    return `
      <div class="glass-card rounded-2xl p-6 space-y-5 border border-white/5 relative overflow-hidden flex flex-col justify-between hover:border-slate-600 transition-all">
        <!-- Header -->
        <div class="flex items-start justify-between">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-mono font-bold uppercase tracking-wider text-brand-kick bg-brand-kick/10 px-2.5 py-0.5 rounded-md border border-brand-kick/20">${clipper.id.toUpperCase()}</span>
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${isActive ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-400'}">
                ${isActive ? '● Activo' : 'Inactivo'}
              </span>
            </div>
            <h3 class="font-bold text-lg text-white mt-2">${clipper.name}</h3>
            <p class="text-xs font-mono text-cyan-400">${clipper.handle || '@sin_usuario'}</p>
          </div>
          <div class="size-12 rounded-2xl bg-slate-900 border border-slate-700/80 text-brand-kick flex items-center justify-center font-black text-base shadow-sm">
            #${index + 1}
          </div>
        </div>

        <!-- Format / Niche Box -->
        <div class="p-3.5 rounded-xl bg-slate-900/90 border border-white/5 space-y-1">
          <span class="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Formato Asignado:</span>
          <p class="text-xs font-semibold text-slate-200">${clipper.role || 'Editor de Contenido General'}</p>
        </div>

        <!-- Direct Personal Link -->
        <div class="space-y-1.5 text-xs">
          <label class="text-slate-400 text-[11px] font-semibold flex items-center gap-1"><i data-lucide="link" class="size-3"></i> Enlace Directo del Clipper:</label>
          <div class="flex items-center gap-1.5 bg-slate-950 p-2 rounded-xl border border-slate-800">
            <input type="text" readonly value="${directLink}" class="bg-transparent text-[11px] font-mono text-slate-300 w-full focus:outline-none select-all" id="link-input-${clipper.id}">
            <button onclick="copyClipperLink('${directLink}')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-brand-kick text-xs font-bold whitespace-nowrap active:scale-95" title="Copiar Enlace">
              Copiar
            </button>
          </div>
        </div>

        <!-- Action Button -->
        <div class="pt-2 border-t border-white/5">
          <button onclick="openEditClipperModal('${clipper.id}')" class="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600/60 hover:border-brand-kick text-white font-bold text-xs transition-all flex items-center justify-center gap-2 shadow-sm active:scale-95">
            <i data-lucide="edit-3" class="size-4 text-brand-kick"></i> Modificar Nombre & Perfil
          </button>
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

function copyClipperLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    alert('📋 Enlace copiado al portapapeles:\n' + url);
  }).catch(() => {
    prompt('Copia este enlace:', url);
  });
}
