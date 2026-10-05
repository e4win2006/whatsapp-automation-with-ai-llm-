// JARVIS — Simplified Personal AI Automation Frontend Controller

let ws = null;
let currentWhatsAppStatus = 'disconnected';
let currentAccountInfo = null;
let currentContacts = [];
let availableWhatsAppContacts = [];
let currentConversations = [];
let activeChatContactId = null;
let selectedAddContact = null;
let editingContactId = null;

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initWebSocket();
  loadInitialData();
});

// --- Navigation & View Controller ---
function initNavigation() {
  const navButtons = document.querySelectorAll('.nav-item');
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tabId) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));

  const activeBtn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  const activePane = document.getElementById(`pane-${tabId}`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activePane) activePane.classList.add('active');

  const titleMap = {
    dashboard: 'Dashboard',
    connection: 'WhatsApp Connection',
    contacts: 'Automated Contacts',
    conversations: 'Conversations',
    calendar: '📅 Calendar & Tasks',
    logs: 'Activity',
    settings: 'Settings'
  };

  document.getElementById('view-title').textContent = titleMap[tabId] || 'JARVIS';

  if (tabId === 'dashboard' || tabId === 'contacts') loadContacts();
  if (tabId === 'conversations') loadConversations();
  if (tabId === 'calendar') loadCalendarData();
  if (tabId === 'logs') loadLogs();
  if (tabId === 'settings') loadSettings();
}

// --- WebSocket Gateway ---
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (err) {
      console.error('[WS Error]', err);
    }
  };

  ws.onclose = () => {
    setTimeout(initWebSocket, 2500);
  };
}

function handleWsEvent(data) {
  const { type, payload } = data;

  switch (type) {
    case 'INIT_STATE':
      const prevStatusInit = currentWhatsAppStatus;
      updateConnectionState(payload.whatsappStatus, payload.accountInfo, payload.qrCode);
      if (payload.masterSwitch !== undefined) {
        setMasterSwitchUI(payload.masterSwitch);
      }
      if (payload.whatsappStatus === 'connected' && prevStatusInit !== 'connected') {
        loadContacts();
      }
      break;

    case 'WHATSAPP_STATUS':
      const prevStatusChange = currentWhatsAppStatus;
      updateConnectionState(payload.status, payload.account);
      if (payload.status === 'connected' && prevStatusChange !== 'connected') {
        console.log('[FRONTEND] WhatsApp client READY: reloading contacts...');
        loadContacts();
      }
      break;

    case 'WHATSAPP_QR':
      updateQrCode(payload.qr);
      break;

    case 'MESSAGE_RECEIVED':
    case 'MESSAGE_SENT':
      if (activeChatContactId && (payload.contactId === activeChatContactId || payload.contact_id === activeChatContactId)) {
        loadMessagesForContact(activeChatContactId);
      }
      loadConversations();
      break;

    case 'AI_RESPONSE_GENERATED':
      if (activeChatContactId && payload.contactId === activeChatContactId) {
        loadMessagesForContact(activeChatContactId);
      }
      loadLogs();
      break;

    case 'MASTER_SWITCH':
      setMasterSwitchUI(payload.enabled);
      break;

    case 'TASK_CREATED':
    case 'TASK_UPDATED':
    case 'TASK_REMINDER_DUE':
    case 'CALENDAR_EVENT_CREATED':
    case 'CALENDAR_EVENT_UPDATED':
      loadCalendarData();
      break;
  }
}

// --- Initial Data Load ---
async function loadInitialData() {
  await loadWhatsAppStatus();
  await loadContacts();
  await loadConversations();
}

// --- Master Switch ---
async function handleMasterSwitchToggle(enabled) {
  setMasterSwitchUI(enabled);
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterSwitch: enabled })
  });
}

function setMasterSwitchUI(enabled) {
  const toggle = document.getElementById('master-switch-toggle');
  const label = document.getElementById('master-state-text');
  toggle.checked = Boolean(enabled);
  if (enabled) {
    label.textContent = 'ON 🟢';
    label.className = 'master-state-text text-accent';
  } else {
    label.textContent = 'OFF ⚪';
    label.className = 'master-state-text text-dim';
  }
}

// --- WhatsApp Connection Status & Pairing ---
async function loadWhatsAppStatus() {
  try {
    const res = await fetch('/api/whatsapp/status');
    const json = await res.json();
    if (json.success) {
      updateConnectionState(json.data.status, json.data.account, json.data.qrCode);
    }
  } catch (err) {}
}

function updateConnectionState(status, account, qrDataUrl) {
  currentWhatsAppStatus = status || 'disconnected';
  currentAccountInfo = account || null;

  const sidebarDot = document.getElementById('sidebar-status-dot');
  const sidebarLabel = document.getElementById('sidebar-status-label');
  const heroDot = document.getElementById('hero-dot');
  const heroText = document.getElementById('hero-status-text');
  const heroSub = document.getElementById('hero-subtext');
  const heroBtn = document.getElementById('hero-action-btn');

  const paneDisconnected = document.getElementById('conn-state-disconnected');
  const paneQr = document.getElementById('conn-state-qr');
  const paneConnected = document.getElementById('conn-state-connected');

  sidebarDot.className = 'status-indicator-dot';
  heroDot.className = 'status-indicator-dot';

  paneDisconnected.classList.add('hidden');
  paneQr.classList.add('hidden');
  paneConnected.classList.add('hidden');

  if (status === 'connected') {
    sidebarDot.classList.add('connected');
    heroDot.classList.add('connected');
    sidebarLabel.textContent = 'WhatsApp Connected';
    heroText.textContent = '🟢 WhatsApp Connected';

    const name = account?.pushname || 'Owner';
    const phone = account?.phone ? `+${account.phone}` : 'Active Session';
    heroSub.textContent = `Connected as ${name} (${phone}). Ready for automation.`;
    heroBtn.textContent = '👥 View Contacts';
    heroBtn.onclick = () => switchTab('contacts');

    document.getElementById('conn-account-info-box').innerHTML = `
      <div><strong>Linked Account:</strong> ${name}</div>
      <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">${phone}</div>
    `;
    paneConnected.classList.remove('hidden');
  } else if (status === 'qr_ready' || status === 'connecting') {
    sidebarDot.classList.add('connecting');
    heroDot.classList.add('connecting');
    sidebarLabel.textContent = status === 'qr_ready' ? 'Scan QR Code' : 'Connecting...';
    heroText.textContent = status === 'qr_ready' ? '🟡 Waiting for QR Scan' : '🟡 Connecting...';
    heroSub.textContent = 'Scan the pairing QR code using WhatsApp on your phone.';
    heroBtn.textContent = '🔗 Scan QR Code';
    heroBtn.onclick = () => switchTab('connection');

    paneQr.classList.remove('hidden');
    if (qrDataUrl) updateQrCode(qrDataUrl);
  } else {
    sidebarDot.classList.add('disconnected');
    heroDot.classList.add('disconnected');
    sidebarLabel.textContent = 'WhatsApp Disconnected';
    heroText.textContent = '🔴 WhatsApp Not Connected';
    heroSub.textContent = 'Connect your WhatsApp to start letting JARVIS automatically reply to approved contacts.';
    heroBtn.textContent = '🔗 Connect WhatsApp';
    heroBtn.onclick = () => switchTab('connection');

    paneDisconnected.classList.remove('hidden');
  }
}

function updateQrCode(qrDataUrl) {
  const holder = document.getElementById('qr-canvas-holder');
  if (qrDataUrl && qrDataUrl.startsWith('data:image')) {
    holder.innerHTML = `<img src="${qrDataUrl}" alt="Scan WhatsApp QR">`;
  } else if (qrDataUrl) {
    holder.innerHTML = `<div class="qr-loading-text">Pairing code ready. Waiting for scan...</div>`;
  }
}

async function startWhatsAppConnection() {
  updateConnectionState('connecting', null, null);
  document.getElementById('qr-canvas-holder').innerHTML = '<div class="qr-loading-text">Starting WhatsApp Web session...</div>';
  switchTab('connection');

  try {
    await fetch('/api/whatsapp/connect', { method: 'POST' });
  } catch (err) {
    alert('Failed to connect: ' + err.message);
  }
}

async function disconnectWhatsApp() {
  if (!confirm('Disconnect your linked WhatsApp account?')) return;
  try {
    await fetch('/api/whatsapp/disconnect', { method: 'POST' });
    updateConnectionState('disconnected', null, null);
  } catch (err) {
    alert('Failed to disconnect: ' + err.message);
  }
}

// --- Contact Search & Filter State ---
let contactsPageSearchQuery = '';
let contactsPageFilterStatus = 'all';
let dashContactsSearchQuery = '';

// --- Automated Contacts (Clean Simple Cards with Search & Filters) ---
let isLoadingContacts = false;
async function loadContacts() {
  if (isLoadingContacts) return;
  isLoadingContacts = true;
  try {
    const res = await fetch('/api/contacts');
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      currentContacts = json.data;
      renderContacts(currentContacts);
    }
  } catch (err) {
    console.warn('[FRONTEND] Failed to load contacts:', err);
  } finally {
    isLoadingContacts = false;
  }
}

function handleContactsPageSearch(query) {
  contactsPageSearchQuery = (query || '').trim().toLowerCase();
  const clearBtn = document.getElementById('contacts-search-clear');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', contactsPageSearchQuery.length === 0);
  }
  renderContacts(currentContacts);
}

function clearContactsPageSearch() {
  const input = document.getElementById('contacts-search-input');
  if (input) input.value = '';
  handleContactsPageSearch('');
}

function setContactFilter(status) {
  contactsPageFilterStatus = status;
  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.filter === status);
  });
  renderContacts(currentContacts);
}

function handleDashContactSearch(query) {
  dashContactsSearchQuery = (query || '').trim().toLowerCase();
  const clearBtn = document.getElementById('dash-search-clear');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', dashContactsSearchQuery.length === 0);
  }
  renderContacts(currentContacts);
}

function clearDashContactSearch() {
  const input = document.getElementById('dash-contacts-search');
  if (input) input.value = '';
  handleDashContactSearch('');
}

function renderContacts(contacts) {
  const dashContainer = document.getElementById('dash-contacts-grid');
  const pageContainer = document.getElementById('contacts-page-grid');

  // Update filter pill counters
  const countAll = contacts.length;
  const countOn = contacts.filter((c) => Boolean(c.ai_enabled)).length;
  const countOff = contacts.filter((c) => !Boolean(c.ai_enabled)).length;

  const countAllBadge = document.getElementById('filter-count-all');
  const countOnBadge = document.getElementById('filter-count-on');
  const countOffBadge = document.getElementById('filter-count-off');
  if (countAllBadge) countAllBadge.textContent = countAll;
  if (countOnBadge) countOnBadge.textContent = countOn;
  if (countOffBadge) countOffBadge.textContent = countOff;

  // Update stat summary
  const statSummaryEl = document.getElementById('contacts-enabled-stat');
  if (statSummaryEl) {
    statSummaryEl.textContent = `${countOn} ${countOn === 1 ? 'contact' : 'contacts'} enabled`;
  }

  // 1. Render Dashboard Contacts Grid
  if (dashContainer) {
    if (contacts.length === 0) {
      dashContainer.innerHTML = renderEmptyContactsHtml();
    } else {
      let dashFiltered = contacts;
      if (dashContactsSearchQuery) {
        dashFiltered = contacts.filter((c) => matchesContactSearch(c, dashContactsSearchQuery));
      }

      if (dashFiltered.length === 0) {
        dashContainer.innerHTML = `
          <div class="empty-contacts-box">
            <div style="font-size: 28px;">🔍</div>
            <h3>No contacts matching "${escapeHtml(dashContactsSearchQuery)}"</h3>
            <p>Try searching for a different name, phone number, or clear the search.</p>
            <button class="btn btn-secondary btn-sm" onclick="clearDashContactSearch()">Clear Search</button>
          </div>
        `;
      } else {
        dashContainer.innerHTML = dashFiltered.map((c) => renderContactCardHtml(c, dashContactsSearchQuery)).join('');
      }
    }
  }

  // 2. Render Main Contacts Page Grid
  if (pageContainer) {
    const summaryEl = document.getElementById('contacts-search-summary');

    if (contacts.length === 0) {
      if (summaryEl) summaryEl.classList.add('hidden');
      pageContainer.innerHTML = renderEmptyContactsHtml();
    } else {
      let pageFiltered = contacts;

      // Status pill filter
      if (contactsPageFilterStatus === 'on') {
        pageFiltered = pageFiltered.filter((c) => Boolean(c.ai_enabled));
      } else if (contactsPageFilterStatus === 'off') {
        pageFiltered = pageFiltered.filter((c) => !Boolean(c.ai_enabled));
      }

      // Query filter across primary name, alternate names, phone numbers
      if (contactsPageSearchQuery) {
        pageFiltered = pageFiltered.filter((c) => matchesContactSearch(c, contactsPageSearchQuery));
      }

      // Summary bar
      if (summaryEl) {
        if (contactsPageSearchQuery || contactsPageFilterStatus !== 'all') {
          summaryEl.classList.remove('hidden');
          summaryEl.innerHTML = `
            <span>Showing <strong>${pageFiltered.length}</strong> of <strong>${contacts.length}</strong> contacts${contactsPageSearchQuery ? ` matching "<em>${escapeHtml(contactsPageSearchQuery)}</em>"` : ''}</span>
            <button class="btn btn-secondary btn-sm" onclick="clearContactsPageSearch(); setContactFilter('all');" style="padding: 2px 8px; font-size: 11px;">Reset Filters</button>
          `;
        } else {
          summaryEl.classList.add('hidden');
        }
      }

      if (pageFiltered.length === 0) {
        pageContainer.innerHTML = `
          <div class="empty-contacts-box">
            <div style="font-size: 28px;">🔍</div>
            <h3>No matching contacts found</h3>
            <p>No contacts matched your search query or status filter.</p>
            <button class="btn btn-secondary btn-sm" onclick="clearContactsPageSearch(); setContactFilter('all');">Clear All Filters</button>
          </div>
        `;
      } else {
        pageContainer.innerHTML = pageFiltered.map((c) => renderContactCardHtml(c, contactsPageSearchQuery)).join('');
      }
    }
  }
}

function parseAlternateNames(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatPhoneNumber(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  if (str.includes('@lid') || str.includes('@g.us') || str.includes('@broadcast') || str === 'status@broadcast') {
    return '';
  }
  const digits = str.replace(/\D/g, '');
  if (!digits || digits.length < 7) return '';
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.substring(2, 7)} ${digits.substring(7)}`;
  }
  if (digits.length === 10) {
    return `+91 ${digits.substring(0, 5)} ${digits.substring(5)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.substring(1, 4)}) ${digits.substring(4, 7)}-${digits.substring(7)}`;
  }
  return `+${digits}`;
}

function matchesContactSearch(c, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  const cleanQDigits = q.replace(/\D/g, '');

  const name = (c.name || '').toLowerCase();
  const phone = (c.phone_number || '').replace(/\D/g, '');
  const id = (c.id || '').toLowerCase();
  const altNames = parseAlternateNames(c.alternate_names).map((n) => n.toLowerCase());

  if (name.includes(q) || id.includes(q)) return true;
  if (altNames.some((alt) => alt.includes(q))) return true;
  if (cleanQDigits && cleanQDigits.length >= 3 && phone.includes(cleanQDigits)) return true;

  return false;
}

function renderEmptyContactsHtml() {
  if (currentWhatsAppStatus !== 'connected') {
    return `
      <div class="empty-contacts-box">
        <div style="font-size: 32px;">📱</div>
        <h3>WhatsApp contacts unavailable</h3>
        <p>WhatsApp is not connected yet. Connect your WhatsApp session to view and configure live contacts.</p>
        <button class="btn btn-primary" onclick="switchTab('connection')">🔗 Connect WhatsApp</button>
      </div>
    `;
  }

  return `
    <div class="empty-contacts-box">
      <div style="font-size: 32px;">👥</div>
      <h3>No automated contacts</h3>
      <p>Choose a WhatsApp contact to allow JARVIS to respond automatically.</p>
      <button class="btn btn-primary" onclick="openAddContactModal()">+ Add WhatsApp Contact</button>
    </div>
  `;
}

function renderContactCardHtml(c, searchQuery) {
  const isAiOn = Boolean(c.ai_enabled);
  const statusDot = isAiOn ? '🟢' : '⚪';
  const statusText = isAiOn ? 'ON' : 'OFF';
  const rawDisplayName = c.name || (c.phone_number ? formatPhoneNumber(c.phone_number) : c.id);
  const highlightedName = searchQuery ? highlightSearchMatch(rawDisplayName, searchQuery) : escapeHtml(rawDisplayName);

  const phoneDisplay = c.phone_number ? formatPhoneNumber(c.phone_number) : '';
  const highlightedPhone = searchQuery && phoneDisplay ? highlightSearchMatch(phoneDisplay, searchQuery) : escapeHtml(phoneDisplay);

  const altNames = parseAlternateNames(c.alternate_names).filter((n) => n && n.trim() && n.toLowerCase() !== rawDisplayName.toLowerCase());
  const highlightedAlts = altNames.map((n) => searchQuery ? highlightSearchMatch(n, searchQuery) : escapeHtml(n)).join(', ');

  const isVoiceMsgOn = Boolean(c.voice_message_enabled);
  const isVoiceRespOn = Boolean(c.voice_response_enabled);

  return `
    <div class="contact-simple-card">
      <div class="csc-left">
        <div class="csc-avatar">👤</div>
        <div class="csc-info">
          <h4>${highlightedName}</h4>
          ${phoneDisplay ? `<div class="csc-phone" style="font-size: 13px; color: var(--text-secondary); margin-top: 2px; font-family: var(--font-mono);">${highlightedPhone}</div>` : ''}
          ${altNames.length > 0 ? `<div class="csc-alt-names" style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Also saved as: <span style="color: var(--text-secondary); font-weight: 500;">${highlightedAlts}</span></div>` : ''}
          <div class="csc-status-row" style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <div>
              <span style="color:var(--text-secondary);">JARVIS:</span>
              <strong style="color: ${isAiOn ? 'var(--accent)' : 'var(--text-muted)'}; font-family:var(--font-mono);">${statusText} ${statusDot}</strong>
            </div>
            ${isVoiceMsgOn ? `<span style="font-size: 11px; background: rgba(56,189,248,0.15); color: var(--accent); padding: 1px 6px; border-radius: 4px; font-family: var(--font-mono);">🎤 Voice In</span>` : ''}
            ${isVoiceRespOn ? `<span style="font-size: 11px; background: rgba(34,197,94,0.15); color: var(--success); padding: 1px 6px; border-radius: 4px; font-family: var(--font-mono);">🔊 Voice Out</span>` : ''}
          </div>
        </div>
      </div>

      <div class="csc-right-actions">
        <button class="btn btn-secondary btn-sm" onclick="openContactChat('${c.id}', '${escapeHtml(rawDisplayName)}')">
          💬 Conversation
        </button>
        <button class="btn btn-secondary btn-sm" onclick="openContactSettingsModal('${c.id}')">
          ⚙️ Settings
        </button>
      </div>
    </div>
  `;
}

// --- Add WhatsApp Contact Modal Flow ---
let isLoadingAvailableContacts = false;
async function openAddContactModal() {
  const modal = document.getElementById('modal-add-contact');
  modal.classList.remove('hidden');

  showSelectModalView();

  document.getElementById('manual-contact-phone').value = '';
  document.getElementById('manual-contact-name').value = '';
  const searchInput = document.getElementById('add-contact-search');
  if (searchInput) searchInput.value = '';
  const searchClear = document.getElementById('add-contact-search-clear');
  if (searchClear) searchClear.classList.add('hidden');
  selectedAddContact = null;

  const listContainer = document.getElementById('available-contacts-list');

  if (currentWhatsAppStatus !== 'connected') {
    listContainer.innerHTML = `
      <div class="empty-state" style="padding: 24px 12px; text-align: center;">
        <div style="font-size: 28px; margin-bottom: 8px;">📱</div>
        <strong style="color: #fff; font-size: 14px;">WhatsApp contacts unavailable</strong>
        <p style="color: var(--text-muted); margin-top: 6px; font-size: 12px;">
          WhatsApp is not connected yet. Connect WhatsApp to choose from conversations, or add a contact by phone number below.
        </p>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = '<div class="empty-state">Loading WhatsApp contacts...</div>';

  if (isLoadingAvailableContacts) return;
  isLoadingAvailableContacts = true;

  try {
    const res = await fetch('/api/whatsapp/available-contacts');
    const json = await res.json();
    if (json.success && Array.isArray(json.data) && json.data.length > 0) {
      availableWhatsAppContacts = json.data;
      const header = document.getElementById('recent-chats-header');
      if (header) {
        header.textContent = `Recent WhatsApp Chats (${availableWhatsAppContacts.length} available)`;
      }
      renderAvailableContacts(availableWhatsAppContacts);
    } else {
      availableWhatsAppContacts = [];
      const header = document.getElementById('recent-chats-header');
      if (header) header.textContent = 'Recent WhatsApp Chats';
      listContainer.innerHTML = `
        <div class="empty-state" style="padding: 24px 12px; text-align: center;">
          <div style="font-size: 28px; margin-bottom: 8px;">💬</div>
          <strong style="color: #fff; font-size: 14px;">No WhatsApp conversations found.</strong>
          <p style="color: var(--text-muted); margin-top: 6px; font-size: 12px; line-height: 1.5;">
            Start a WhatsApp conversation first,<br>then return here to enable JARVIS automation.
          </p>
        </div>
      `;
    }
  } catch (err) {
    listContainer.innerHTML = `
      <div class="empty-state" style="padding: 24px 12px; text-align: center;">
        <div style="font-size: 28px; margin-bottom: 8px;">📱</div>
        <strong style="color: #fff; font-size: 14px;">WhatsApp contacts unavailable</strong>
        <p style="color: var(--text-muted); margin-top: 6px; font-size: 12px;">
          Connect WhatsApp to choose from conversations, or add a contact by phone number below.
        </p>
      </div>
    `;
  } finally {
    isLoadingAvailableContacts = false;
  }
}

function showSelectModalView() {
  document.getElementById('add-modal-title').textContent = 'Add WhatsApp Contact';
  document.getElementById('add-modal-body-select').classList.remove('hidden');
  document.getElementById('add-modal-body-confirm').classList.add('hidden');
  document.getElementById('add-modal-foot-default').classList.remove('hidden');
}

function backToSelectModal() {
  showSelectModalView();
}

function renderAvailableContacts(contacts, searchQuery = '') {
  const container = document.getElementById('available-contacts-list');
  if (contacts.length === 0) {
    container.innerHTML = '<div class="empty-state">No WhatsApp contacts match your search.</div>';
    return;
  }

  container.innerHTML = contacts.map((c) => {
    const rawName = c.name || (c.number ? formatPhoneNumber(c.number) : 'WhatsApp Contact');
    const displayName = searchQuery ? highlightSearchMatch(rawName, searchQuery) : escapeHtml(rawName);
    const phoneFormatted = c.number ? formatPhoneNumber(c.number) : '';
    const altNames = Array.isArray(c.alternateNames) ? c.alternateNames : parseAlternateNames(c.alternateNames);
    const altText = altNames.length > 0 ? `Also: ${altNames.join(', ')}` : '';

    return `
      <div class="ac-row" onclick="selectAvailableContact('${c.id}', '${escapeHtml(rawName)}')">
        <div style="font-size: 20px; line-height: 1;">👤</div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 13px; color: #fff;">${displayName}</div>
          ${phoneFormatted && phoneFormatted !== rawName ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; font-family: var(--font-mono);">${escapeHtml(phoneFormatted)}</div>` : ''}
          ${altText ? `<div style="font-size: 11px; color: var(--text-dim); margin-top: 1px;">${escapeHtml(altText)}</div>` : ''}
        </div>
        <button class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 11px;">Select →</button>
      </div>
    `;
  }).join('');
}

function filterAvailableContacts(query) {
  const q = (query || '').trim().toLowerCase();
  const cleanQDigits = q.replace(/\D/g, '');
  const clearBtn = document.getElementById('add-contact-search-clear');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', q.length === 0);
  }
  const filtered = availableWhatsAppContacts.filter((c) => {
    const name = (c.name || '').toLowerCase();
    const num = (c.number || '').replace(/\D/g, '');
    const id = (c.id || '').toLowerCase();
    const alts = (Array.isArray(c.alternateNames) ? c.alternateNames : parseAlternateNames(c.alternateNames)).map((n) => n.toLowerCase());

    if (name.includes(q) || id.includes(q)) return true;
    if (alts.some((alt) => alt.includes(q))) return true;
    if (cleanQDigits && cleanQDigits.length >= 3 && num.includes(cleanQDigits)) return true;
    return false;
  });
  renderAvailableContacts(filtered, q);
}

function clearAvailableContactsSearch() {
  const input = document.getElementById('add-contact-search');
  if (input) input.value = '';
  filterAvailableContacts('');
}

function selectAvailableContact(id, name) {
  selectedAddContact = { id, name };
  promptContactConfirmation(name);
}

function promptContactConfirmation(name) {
  document.getElementById('add-modal-title').textContent = name;
  document.getElementById('confirm-contact-name').textContent = name;
  document.getElementById('add-modal-body-select').classList.add('hidden');
  document.getElementById('add-modal-body-confirm').classList.remove('hidden');
  document.getElementById('add-modal-foot-default').classList.add('hidden');
}

async function confirmAddContactWithAutomation(enableAi) {
  if (!selectedAddContact) return;
  const { id, name } = selectedAddContact;

  try {
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, aiEnabled: enableAi })
    });
    const json = await res.json();
    if (json.success) {
      closeAddContactModal();
      await loadContacts();
    }
  } catch (err) {
    alert('Failed to add contact: ' + err.message);
  }
}

function closeAddContactModal() {
  document.getElementById('modal-add-contact').classList.add('hidden');
  showSelectModalView();
}

async function handleAddContactSubmit() {
  let id = selectedAddContact?.id;
  let name = selectedAddContact?.name;

  const manualPhone = document.getElementById('manual-contact-phone').value.trim();
  const manualName = document.getElementById('manual-contact-name').value.trim();

  if (!id && manualPhone) {
    id = manualPhone.includes('@') ? manualPhone : `${manualPhone.replace(/\D/g, '')}@c.us`;
    name = manualName || `+${manualPhone.replace(/\D/g, '')}`;
    selectedAddContact = { id, name };
    promptContactConfirmation(name);
    return;
  }

  if (!id) {
    alert('Please select a WhatsApp contact or enter a phone number.');
    return;
  }

  promptContactConfirmation(name || id);
}

// --- Contact Settings & Privacy & Routines Flow ---
let currentContactRoutines = [];
let editingRoutineId = null;

async function openContactSettingsModal(contactId) {
  editingContactId = contactId;
  const contact = currentContacts.find((c) => c.id === contactId);
  if (!contact) return;

  document.getElementById('modal-contact-settings').classList.remove('hidden');
  document.getElementById('cset-modal-title').textContent = `👤 Contact Details`;
  document.getElementById('cset-display-name').textContent = contact.name || contact.id;
  document.getElementById('cset-phone-display').textContent = contact.phone_number ? formatPhoneNumber(contact.phone_number) : (contact.id || 'No Phone');

  const isAiOn = Boolean(contact.ai_enabled);
  updateContactSettingsButtonUI(isAiOn);

  const isVoiceMsgOn = Boolean(contact.voice_message_enabled);
  updateVoiceMessageButtonUI(isVoiceMsgOn);

  const isVoiceRespOn = Boolean(contact.voice_response_enabled);
  updateVoiceResponseButtonUI(isVoiceRespOn);

  // Metadata
  document.getElementById('cset-relationship').value = contact.relationship || '';
  document.getElementById('cset-description').value = contact.description || '';
  document.getElementById('cset-birthday').value = contact.birthday || '';
  if (document.getElementById('cset-anniversary')) {
    document.getElementById('cset-anniversary').value = contact.anniversary || '';
  }
  if (document.getElementById('cset-important-dates')) {
    document.getElementById('cset-important-dates').value = contact.important_dates || '';
  }
  document.getElementById('cset-birthday-msg').value = contact.birthday_message || '';

  // Privacy Permissions
  let perms = {
    useJarvis: true,
    viewMessages: false,
    viewNotifications: false,
    viewContacts: false,
    viewCalendar: false,
    createReminders: false,
    createCalendarEvents: false,
    modifyCalendarEvents: false,
    deleteCalendarEvents: false,
    viewFiles: false,
    viewLocation: false,
    viewPersonalInformation: false
  };

  if (contact.permissions) {
    try {
      const parsed = typeof contact.permissions === 'string' ? JSON.parse(contact.permissions) : contact.permissions;
      perms = { ...perms, ...parsed };
    } catch (e) {}
  }

  document.getElementById('perm-use-jarvis').checked = perms.useJarvis !== false;
  document.getElementById('perm-view-messages').checked = Boolean(perms.viewMessages);
  document.getElementById('perm-view-notifications').checked = Boolean(perms.viewNotifications);
  document.getElementById('perm-view-contacts').checked = Boolean(perms.viewContacts);
  document.getElementById('perm-view-calendar').checked = Boolean(perms.viewCalendar);
  if (document.getElementById('perm-create-reminders')) {
    document.getElementById('perm-create-reminders').checked = Boolean(perms.createReminders);
  }
  if (document.getElementById('perm-create-calendar-events')) {
    document.getElementById('perm-create-calendar-events').checked = Boolean(perms.createCalendarEvents);
  }
  if (document.getElementById('perm-modify-calendar-events')) {
    document.getElementById('perm-modify-calendar-events').checked = Boolean(perms.modifyCalendarEvents);
  }
  if (document.getElementById('perm-delete-calendar-events')) {
    document.getElementById('perm-delete-calendar-events').checked = Boolean(perms.deleteCalendarEvents);
  }
  document.getElementById('perm-view-files').checked = Boolean(perms.viewFiles);
  document.getElementById('perm-view-location').checked = Boolean(perms.viewLocation);
  document.getElementById('perm-view-personal-info').checked = Boolean(perms.viewPersonalInformation);

  // AI Capabilities
  let caps = {
    chat: true,
    generalAI: true,
    coding: false,
    translation: true,
    summarization: true,
    webSearch: false,
    voice: true,
    routines: true
  };
  if (contact.ai_capabilities) {
    try {
      const parsedCaps = typeof contact.ai_capabilities === 'string' ? JSON.parse(contact.ai_capabilities) : contact.ai_capabilities;
      caps = { ...caps, ...parsedCaps };
    } catch (e) {}
  }
  if (document.getElementById('cap-chat')) document.getElementById('cap-chat').checked = caps.chat !== false;
  if (document.getElementById('cap-general-ai')) document.getElementById('cap-general-ai').checked = caps.generalAI !== false;
  if (document.getElementById('cap-coding')) document.getElementById('cap-coding').checked = Boolean(caps.coding);
  if (document.getElementById('cap-translation')) document.getElementById('cap-translation').checked = caps.translation !== false;
  if (document.getElementById('cap-summarization')) document.getElementById('cap-summarization').checked = caps.summarization !== false;
  if (document.getElementById('cap-web-search')) document.getElementById('cap-web-search').checked = Boolean(caps.webSearch);
  if (document.getElementById('cap-voice')) document.getElementById('cap-voice').checked = caps.voice !== false;
  if (document.getElementById('cap-routines')) document.getElementById('cap-routines').checked = caps.routines !== false;

  // Automation flags
  document.getElementById('cset-wake-only').checked = contact.wake_phrase_only !== 0;
  document.getElementById('cset-memory').checked = contact.memory_enabled !== 0;
  document.getElementById('cset-normal-msgs').checked = contact.respond_normal_messages === 1;
  document.getElementById('cset-delay').value = String(contact.response_delay_seconds || 180);

  // Load routines for this contact
  await loadContactRoutines(contactId);
}

async function loadContactRoutines(contactId) {
  const container = document.getElementById('cset-routines-list');
  container.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 6px;">Loading routines...</div>';

  try {
    const res = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/routines`);
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      currentContactRoutines = json.data;
      renderContactRoutines(currentContactRoutines);
    } else {
      currentContactRoutines = [];
      renderContactRoutines([]);
    }
  } catch (err) {
    container.innerHTML = '<div style="font-size: 11px; color: var(--danger); text-align: center; padding: 6px;">Failed to load routines</div>';
  }
}

function renderContactRoutines(routines) {
  const container = document.getElementById('cset-routines-list');
  if (routines.length === 0) {
    container.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 8px;">No scheduled routines for this contact.</div>';
    return;
  }

  container.innerHTML = routines.map((r) => {
    const isEnabled = r.enabled === 1;
    const typeLabel = r.type.toUpperCase().replace('_', ' ');
    return `
      <div style="background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="font-size: 13px; color: #fff;">${escapeHtml(r.name)}</strong>
            <span style="font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(56,189,248,0.15); color: var(--accent); font-family: var(--font-mono);">${typeLabel}</span>
            <span style="font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono);">${r.time}</span>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            "${escapeHtml(r.message)}"
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center; margin-left: 12px;">
          <button class="btn btn-secondary btn-sm" onclick="handleToggleRoutine('${r.id}', ${!isEnabled})" style="padding: 2px 8px; font-size: 11px; color: ${isEnabled ? 'var(--accent)' : 'var(--text-muted)'};">
            ${isEnabled ? '🟢 Active' : '⚪ Disabled'}
          </button>
          <button class="btn btn-secondary btn-sm" onclick="openEditRoutineModal('${r.id}')" style="padding: 2px 8px; font-size: 11px;">
            ✏️
          </button>
          <button class="btn btn-danger btn-sm" onclick="handleDeleteRoutine('${r.id}')" style="padding: 2px 6px; font-size: 11px;">
            🗑️
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function updateContactSettingsButtonUI(isAiOn) {
  const btn = document.getElementById('cset-auto-btn');
  if (isAiOn) {
    btn.textContent = '🟢 ON';
    btn.className = 'toggle-pill-btn on';
  } else {
    btn.textContent = '⚪ OFF';
    btn.className = 'toggle-pill-btn off';
  }
}

function toggleContactSettingsAutomation() {
  const btn = document.getElementById('cset-auto-btn');
  const isCurrentlyOn = btn.classList.contains('on');
  updateContactSettingsButtonUI(!isCurrentlyOn);
}

function updateVoiceMessageButtonUI(isOn) {
  const btn = document.getElementById('cset-voice-msg-btn');
  if (!btn) return;
  if (isOn) {
    btn.textContent = '🟢 ON';
    btn.className = 'toggle-pill-btn on';
  } else {
    btn.textContent = '⚪ OFF';
    btn.className = 'toggle-pill-btn off';
  }
}

function toggleContactVoiceMessageSetting() {
  const btn = document.getElementById('cset-voice-msg-btn');
  if (!btn) return;
  const isCurrentlyOn = btn.classList.contains('on');
  updateVoiceMessageButtonUI(!isCurrentlyOn);
}

function updateVoiceResponseButtonUI(isOn) {
  const btn = document.getElementById('cset-voice-resp-btn');
  if (!btn) return;
  if (isOn) {
    btn.textContent = '🟢 ON';
    btn.className = 'toggle-pill-btn on';
  } else {
    btn.textContent = '⚪ OFF';
    btn.className = 'toggle-pill-btn off';
  }
}

function toggleContactVoiceResponseSetting() {
  const btn = document.getElementById('cset-voice-resp-btn');
  if (!btn) return;
  const isCurrentlyOn = btn.classList.contains('on');
  updateVoiceResponseButtonUI(!isCurrentlyOn);
}

function closeContactSettingsModal() {
  document.getElementById('modal-contact-settings').classList.add('hidden');
  editingContactId = null;
}

async function handleSaveContactSettings() {
  if (!editingContactId) return;

  const isAiOn = document.getElementById('cset-auto-btn').classList.contains('on');
  const isVoiceMsgOn = document.getElementById('cset-voice-msg-btn') ? document.getElementById('cset-voice-msg-btn').classList.contains('on') : false;
  const isVoiceRespOn = document.getElementById('cset-voice-resp-btn') ? document.getElementById('cset-voice-resp-btn').classList.contains('on') : false;
  const relationship = document.getElementById('cset-relationship').value.trim();
  const description = document.getElementById('cset-description').value.trim();
  const birthday = document.getElementById('cset-birthday').value.trim();
  const anniversary = document.getElementById('cset-anniversary') ? document.getElementById('cset-anniversary').value.trim() : '';
  const importantDates = document.getElementById('cset-important-dates') ? document.getElementById('cset-important-dates').value.trim() : '';
  const birthdayMsg = document.getElementById('cset-birthday-msg').value.trim();

  const permissions = {
    useJarvis: document.getElementById('perm-use-jarvis').checked,
    viewMessages: document.getElementById('perm-view-messages').checked,
    viewNotifications: document.getElementById('perm-view-notifications').checked,
    viewContacts: document.getElementById('perm-view-contacts').checked,
    viewCalendar: document.getElementById('perm-view-calendar').checked,
    createReminders: document.getElementById('perm-create-reminders') ? document.getElementById('perm-create-reminders').checked : false,
    createCalendarEvents: document.getElementById('perm-create-calendar-events') ? document.getElementById('perm-create-calendar-events').checked : false,
    modifyCalendarEvents: document.getElementById('perm-modify-calendar-events') ? document.getElementById('perm-modify-calendar-events').checked : false,
    deleteCalendarEvents: document.getElementById('perm-delete-calendar-events') ? document.getElementById('perm-delete-calendar-events').checked : false,
    viewFiles: document.getElementById('perm-view-files').checked,
    viewLocation: document.getElementById('perm-view-location').checked,
    viewPersonalInformation: document.getElementById('perm-view-personal-info').checked
  };

  const aiCapabilities = {
    chat: document.getElementById('cap-chat') ? document.getElementById('cap-chat').checked : true,
    generalAI: document.getElementById('cap-general-ai') ? document.getElementById('cap-general-ai').checked : true,
    coding: document.getElementById('cap-coding') ? document.getElementById('cap-coding').checked : false,
    translation: document.getElementById('cap-translation') ? document.getElementById('cap-translation').checked : true,
    summarization: document.getElementById('cap-summarization') ? document.getElementById('cap-summarization').checked : true,
    webSearch: document.getElementById('cap-web-search') ? document.getElementById('cap-web-search').checked : false,
    voice: document.getElementById('cap-voice') ? document.getElementById('cap-voice').checked : true,
    routines: document.getElementById('cap-routines') ? document.getElementById('cap-routines').checked : true
  };

  const wakeOnly = document.getElementById('cset-wake-only').checked;
  const memory = document.getElementById('cset-memory').checked;
  const normalMsgs = document.getElementById('cset-normal-msgs').checked;
  const delaySec = Number(document.getElementById('cset-delay').value) || 180;

  await fetch(`/api/contacts/${encodeURIComponent(editingContactId)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ai_enabled: isAiOn,
      voice_message_enabled: isVoiceMsgOn,
      voice_response_enabled: isVoiceRespOn,
      relationship: relationship || null,
      description: description || null,
      birthday: birthday || null,
      anniversary: anniversary || null,
      important_dates: importantDates || null,
      birthday_message: birthdayMsg || null,
      permissions: permissions,
      ai_capabilities: aiCapabilities,
      wake_phrase_only: wakeOnly,
      memory_enabled: memory,
      respond_normal_messages: normalMsgs,
      response_delay_seconds: delaySec
    })
  });

  closeContactSettingsModal();
  loadContacts();
}

async function handleDeleteCurrentContact() {
  if (!editingContactId) return;
  if (!confirm('Remove this contact from JARVIS automation?')) return;

  await fetch(`/api/contacts/${encodeURIComponent(editingContactId)}`, { method: 'DELETE' });
  closeContactSettingsModal();
  loadContacts();
}

// --- Routine Edit / Creation Sub-Modal Flow ---
function openAddRoutineModal() {
  if (!editingContactId) return;
  editingRoutineId = null;
  document.getElementById('routine-modal-title').textContent = 'Add Scheduled Routine';
  document.getElementById('routine-name').value = '';
  document.getElementById('routine-type').value = 'daily';
  document.getElementById('routine-time').value = '08:00';
  document.getElementById('routine-message').value = '';
  document.getElementById('routine-enabled').checked = true;
  handleRoutineTypeChange('daily');
  document.getElementById('modal-routine-edit').classList.remove('hidden');
}

function openEditRoutineModal(routineId) {
  const routine = currentContactRoutines.find((r) => r.id === routineId);
  if (!routine) return;
  editingRoutineId = routineId;
  document.getElementById('routine-modal-title').textContent = 'Edit Routine';
  document.getElementById('routine-name').value = routine.name;
  document.getElementById('routine-type').value = routine.type;
  document.getElementById('routine-time').value = routine.time;
  document.getElementById('routine-message').value = routine.message;
  document.getElementById('routine-enabled').checked = routine.enabled === 1;

  if (routine.day_of_month) {
    document.getElementById('routine-day-of-month').value = String(routine.day_of_month);
    document.getElementById('routine-yearly-day').value = String(routine.day_of_month);
  }
  if (routine.month) {
    document.getElementById('routine-yearly-month').value = String(routine.month);
  }
  if (routine.date) {
    document.getElementById('routine-specific-date').value = routine.date;
  }

  handleRoutineTypeChange(routine.type);
  document.getElementById('modal-routine-edit').classList.remove('hidden');
}

function closeRoutineModal() {
  document.getElementById('modal-routine-edit').classList.add('hidden');
  editingRoutineId = null;
}

function handleRoutineTypeChange(type) {
  document.getElementById('routine-weekly-group').classList.toggle('hidden', type !== 'weekly');
  document.getElementById('routine-monthly-group').classList.toggle('hidden', type !== 'monthly');
  document.getElementById('routine-yearly-group').classList.toggle('hidden', type !== 'yearly');
  document.getElementById('routine-date-group').classList.toggle('hidden', type !== 'specific_date');
}

async function handleSaveRoutine() {
  if (!editingContactId) return;

  const name = document.getElementById('routine-name').value.trim();
  const type = document.getElementById('routine-type').value;
  const time = document.getElementById('routine-time').value;
  const message = document.getElementById('routine-message').value.trim();
  const enabled = document.getElementById('routine-enabled').checked;

  if (!name || !time || !message) {
    alert('Please enter a routine name, scheduled time, and message.');
    return;
  }

  let daysOfWeek = null;
  if (type === 'weekly') {
    const checked = Array.from(document.querySelectorAll('input[name="routine-day"]:checked')).map((el) => el.value);
    if (checked.length === 0) {
      alert('Please select at least one day of the week.');
      return;
    }
    daysOfWeek = checked;
  }

  let dayOfMonth = null;
  if (type === 'monthly') {
    dayOfMonth = Number(document.getElementById('routine-day-of-month').value) || 1;
  }

  let month = null;
  if (type === 'yearly') {
    month = Number(document.getElementById('routine-yearly-month').value) || 1;
    dayOfMonth = Number(document.getElementById('routine-yearly-day').value) || 1;
  }

  let date = null;
  if (type === 'specific_date') {
    date = document.getElementById('routine-specific-date').value;
    if (!date) {
      alert('Please select a specific date.');
      return;
    }
  }

  const payload = {
    name,
    type,
    time,
    message,
    enabled,
    days_of_week: daysOfWeek,
    day_of_month: dayOfMonth,
    month,
    date
  };

  try {
    if (editingRoutineId) {
      await fetch(`/api/routines/${encodeURIComponent(editingRoutineId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      await fetch(`/api/contacts/${encodeURIComponent(editingContactId)}/routines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    closeRoutineModal();
    await loadContactRoutines(editingContactId);
  } catch (err) {
    alert('Failed to save routine: ' + err.message);
  }
}

async function handleToggleRoutine(routineId, newEnabled) {
  try {
    await fetch(`/api/routines/${encodeURIComponent(routineId)}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled })
    });
    if (editingContactId) {
      await loadContactRoutines(editingContactId);
    }
  } catch (err) {
    alert('Failed to toggle routine: ' + err.message);
  }
}

async function handleDeleteRoutine(routineId) {
  if (!confirm('Delete this scheduled routine?')) return;
  try {
    await fetch(`/api/routines/${encodeURIComponent(routineId)}`, { method: 'DELETE' });
    if (editingContactId) {
      await loadContactRoutines(editingContactId);
    }
  } catch (err) {
    alert('Failed to delete routine: ' + err.message);
  }
}

// --- Conversations & Natural Chat View ---
function openContactChat(contactId, displayName) {
  switchTab('conversations');
  selectConversation(contactId, displayName);
}

async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    const json = await res.json();
    if (json.success) {
      currentConversations = json.data;
      renderConversationsList(currentConversations);
    }
  } catch (err) {}
}

function renderConversationsList(convs) {
  const container = document.getElementById('conversations-list-container');
  if (convs.length === 0) {
    container.innerHTML = '<div class="empty-state">No active chats yet.</div>';
    return;
  }

  container.innerHTML = convs.map((c) => {
    const isActive = activeChatContactId === c.contact_id ? 'active' : '';
    const displayName = c.contact_name || c.contact_id;
    const preview = c.last_message_text || 'No messages yet';

    return `
      <div class="chat-item ${isActive}" onclick="selectConversation('${c.contact_id}', '${escapeHtml(displayName)}')">
        <div style="font-weight: 700; font-size: 13px; color: #fff;">${escapeHtml(displayName)}</div>
        <div style="font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;">
          ${escapeHtml(preview)}
        </div>
      </div>
    `;
  }).join('');
}

function filterConversations(query) {
  const q = query.toLowerCase();
  const filtered = currentConversations.filter((c) => (c.contact_name || '').toLowerCase().includes(q) || c.contact_id.includes(q));
  renderConversationsList(filtered);
}

async function selectConversation(contactId, displayName) {
  activeChatContactId = contactId;
  renderConversationsList(currentConversations);

  document.getElementById('active-chat-title').textContent = displayName || contactId;
  document.getElementById('active-chat-sub').textContent = contactId;

  const contact = currentContacts.find((c) => c.id === contactId);
  const pill = document.getElementById('active-chat-status-pill');
  const pillText = document.getElementById('active-chat-auto-text');

  const voiceInPill = document.getElementById('active-chat-voice-in-pill');
  const voiceInText = document.getElementById('active-chat-voice-in-text');
  const voiceOutPill = document.getElementById('active-chat-voice-out-pill');
  const voiceOutText = document.getElementById('active-chat-voice-out-text');
  const settingsBtn = document.getElementById('active-chat-settings-btn');

  if (settingsBtn) settingsBtn.style.display = 'inline-block';

  if (contact && contact.ai_enabled) {
    if (pill) {
      pill.style.display = 'inline-block';
      pillText.textContent = '🟢 ON';
      pillText.style.color = 'var(--accent)';
    }
  } else {
    if (pill) {
      pill.style.display = 'inline-block';
      pillText.textContent = '⚪ OFF';
      pillText.style.color = 'var(--text-muted)';
    }
  }

  const isVoiceInOn = Boolean(contact && contact.voice_message_enabled);
  if (voiceInPill && voiceInText) {
    voiceInPill.style.display = 'inline-block';
    if (isVoiceInOn) {
      voiceInText.textContent = '🟢 ON';
      voiceInPill.style.background = 'rgba(56,189,248,0.15)';
      voiceInPill.style.borderColor = 'rgba(56,189,248,0.3)';
      voiceInPill.style.color = 'var(--accent)';
    } else {
      voiceInText.textContent = '⚪ OFF';
      voiceInPill.style.background = 'rgba(255,255,255,0.04)';
      voiceInPill.style.borderColor = 'rgba(255,255,255,0.08)';
      voiceInPill.style.color = 'var(--text-muted)';
    }
  }

  const isVoiceOutOn = Boolean(contact && contact.voice_response_enabled);
  if (voiceOutPill && voiceOutText) {
    voiceOutPill.style.display = 'inline-block';
    if (isVoiceOutOn) {
      voiceOutText.textContent = '🟢 ON';
      voiceOutPill.style.background = 'rgba(34,197,94,0.15)';
      voiceOutPill.style.borderColor = 'rgba(34,197,94,0.3)';
      voiceOutPill.style.color = 'var(--success)';
    } else {
      voiceOutText.textContent = '⚪ OFF';
      voiceOutPill.style.background = 'rgba(255,255,255,0.04)';
      voiceOutPill.style.borderColor = 'rgba(255,255,255,0.08)';
      voiceOutPill.style.color = 'var(--text-muted)';
    }
  }

  await loadMessagesForContact(contactId);
}

async function loadMessagesForContact(contactId) {
  try {
    const res = await fetch(`/api/messages?contactId=${encodeURIComponent(contactId)}`);
    const json = await res.json();
    if (json.success) {
      renderMessages(json.data);
    }
  } catch (err) {}
}

function renderMessages(messages) {
  const container = document.getElementById('chat-messages-area');
  if (messages.length === 0) {
    container.innerHTML = '<div class="empty-state">No messages in this chat.</div>';
    return;
  }

  container.innerHTML = messages.map((m) => {
    const isIncoming = m.direction === 'incoming';
    const isJarvis = m.trigger_type === 'ai_reply';
    const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let rawPayload = null;
    if (m.raw_payload) {
      try {
        rawPayload = typeof m.raw_payload === 'string' ? JSON.parse(m.raw_payload) : m.raw_payload;
      } catch (e) {}
    }

    const isVoice = rawPayload?.messageType === 'voice' || m.trigger_type === 'voice';
    const audioDuration = rawPayload?.audioDuration;
    const transcript = rawPayload?.transcript || m.message_text;

    let bubbleClass = 'msg-in';
    let senderTag = '<span>Contact</span>';

    if (!isIncoming) {
      if (isJarvis) {
        bubbleClass = 'msg-out-jarvis';
        senderTag = '<span class="tag-jarvis">🤖 JARVIS</span>';
      } else {
        bubbleClass = 'msg-out-manual';
        senderTag = '<span>You</span>';
      }
    }

    let messageBodyHtml = `<div>${escapeHtml(m.message_text)}</div>`;
    if (isVoice) {
      messageBodyHtml = `
        <div class="voice-message-bubble-content">
          <div style="font-weight: 600; color: var(--accent); display: flex; align-items: center; gap: 6px; font-size: 13px; margin-bottom: 4px;">
            <span>🎤 Voice message</span>
            ${audioDuration ? `<span style="font-size: 11px; opacity: 0.85; font-family: var(--font-mono); background: rgba(56,189,248,0.15); padding: 1px 6px; border-radius: 4px;">${audioDuration} sec</span>` : ''}
          </div>
          <div style="font-size: 13px; color: var(--text-primary); line-height: 1.4; margin-top: 4px;">
            <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 700; margin-bottom: 2px;">Transcript:</div>
            <em>"${escapeHtml(transcript)}"</em>
          </div>
        </div>
      `;
    }

    return `
      <div class="msg-bubble ${bubbleClass}">
        <div class="msg-top-meta">
          ${senderTag}
          <span>${time}</span>
        </div>
        ${messageBodyHtml}
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-reply-input');
  const text = input.value.trim();
  if (!text || !activeChatContactId) return;

  input.value = '';
  try {
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: activeChatContactId, message: text })
    });
    loadMessagesForContact(activeChatContactId);
  } catch (err) {}
}

// --- Activity Logs ---
async function loadLogs() {
  try {
    const res = await fetch('/api/logs?limit=80');
    const json = await res.json();
    const box = document.getElementById('logs-feed-container');
    if (json.success && json.data.length > 0) {
      box.innerHTML = json.data.map((l) => {
        const time = new Date(l.timestamp).toLocaleTimeString();
        return `
          <div class="log-entry">
            <span class="log-t">[${time}]</span>
            <span class="log-m">[${l.module}]</span>
            <span>${escapeHtml(l.message)}</span>
          </div>
        `;
      }).join('');
      box.scrollTop = box.scrollHeight;
    } else {
      box.innerHTML = '<div class="empty-state">No activity logged yet.</div>';
    }
  } catch (err) {}
}

// --- Settings ---
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const json = await res.json();
    if (json.success) {
      const s = json.data;
      if (s.ai_provider && document.getElementById('cfg-ai-provider')) document.getElementById('cfg-ai-provider').value = s.ai_provider;
      if (s.groq_api_key && document.getElementById('cfg-groq-key')) document.getElementById('cfg-groq-key').value = s.groq_api_key;
      if (s.groq_model && document.getElementById('cfg-groq-model')) document.getElementById('cfg-groq-model').value = s.groq_model;
      if (s.system_prompt && document.getElementById('cfg-system-prompt')) document.getElementById('cfg-system-prompt').value = s.system_prompt;
      if (s.response_delay_seconds && document.getElementById('cfg-delay-select')) document.getElementById('cfg-delay-select').value = s.response_delay_seconds;
      if (s.stt_provider && document.getElementById('cfg-stt-provider')) document.getElementById('cfg-stt-provider').value = s.stt_provider;
      if (s.stt_lang && document.getElementById('cfg-stt-lang')) document.getElementById('cfg-stt-lang').value = s.stt_lang;
      if (s.tts_voice && document.getElementById('cfg-tts-voice')) document.getElementById('cfg-tts-voice').value = s.tts_voice;
      if (s.tts_format && document.getElementById('cfg-tts-format')) document.getElementById('cfg-tts-format').value = s.tts_format;

      if (s.wake_phrases) {
        try {
          document.getElementById('cfg-wake-phrases').value = JSON.parse(s.wake_phrases).join(', ');
        } catch {
          document.getElementById('cfg-wake-phrases').value = s.wake_phrases;
        }
      }
    }
  } catch (err) {}
}

async function handleSaveSettings(event) {
  event.preventDefault();
  const aiProvider = document.getElementById('cfg-ai-provider')?.value;
  const groqApiKey = document.getElementById('cfg-groq-key')?.value;
  const groqModel = document.getElementById('cfg-groq-model')?.value;
  const systemPrompt = document.getElementById('cfg-system-prompt')?.value;
  const responseDelay = document.getElementById('cfg-delay-select')?.value;
  const wakePhrases = document.getElementById('cfg-wake-phrases')?.value;
  const sttProvider = document.getElementById('cfg-stt-provider')?.value;
  const sttLang = document.getElementById('cfg-stt-lang')?.value;
  const ttsVoice = document.getElementById('cfg-tts-voice')?.value;
  const ttsFormat = document.getElementById('cfg-tts-format')?.value;

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      aiProvider,
      groqApiKey,
      groqModel,
      systemPrompt,
      responseDelay,
      wakePhrases,
      sttProvider,
      sttLang,
      ttsVoice,
      ttsFormat
    })
  });

  alert('Settings saved successfully!');
}

// --- Calendar & Delegated Tasks Controller ---
let currentCalYear = new Date().getFullYear();
let currentCalMonth = new Date().getMonth(); // 0-indexed
let selectedCalDate = new Date().toISOString().split('T')[0];
let calendarEvents = [];
let calendarTasks = [];
let contactImportantDates = [];
let currentTaskFilter = 'pending';

async function loadCalendarData() {
  try {
    const [eventsRes, tasksRes, datesRes] = await Promise.all([
      fetch('/api/calendar/events').then(r => r.json()),
      fetch('/api/tasks').then(r => r.json()),
      fetch('/api/contacts/dates').then(r => r.json())
    ]);

    if (eventsRes.success) calendarEvents = eventsRes.data || [];
    if (tasksRes.success) calendarTasks = tasksRes.data || [];
    if (datesRes.success) contactImportantDates = datesRes.data || [];

    renderCalendar();
    renderSelectedDayDetails(selectedCalDate);
    renderTasksList();
    renderContactDatesList();
  } catch (err) {
    console.error('[CALENDAR] Failed to load calendar data:', err);
  }
}

function prevMonth() {
  currentCalMonth--;
  if (currentCalMonth < 0) {
    currentCalMonth = 11;
    currentCalYear--;
  }
  renderCalendar();
}

function nextMonth() {
  currentCalMonth++;
  if (currentCalMonth > 11) {
    currentCalMonth = 0;
    currentCalYear++;
  }
  renderCalendar();
}

function goToToday() {
  const now = new Date();
  currentCalYear = now.getFullYear();
  currentCalMonth = now.getMonth();
  selectedCalDate = now.toISOString().split('T')[0];
  renderCalendar();
  renderSelectedDayDetails(selectedCalDate);
}

function selectCalendarDate(dateStr) {
  selectedCalDate = dateStr;
  document.querySelectorAll('.cal-day-cell').forEach(cell => {
    cell.classList.toggle('is-selected', cell.dataset.date === dateStr);
  });
  renderSelectedDayDetails(dateStr);
}

function renderCalendar() {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const titleEl = document.getElementById('cal-month-title');
  if (titleEl) {
    titleEl.textContent = `${monthNames[currentCalMonth]} ${currentCalYear}`;
  }

  const gridEl = document.getElementById('cal-days-grid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  const firstDayOfMonth = new Date(currentCalYear, currentCalMonth, 1);
  const daysInMonth = new Date(currentCalYear, currentCalMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(currentCalYear, currentCalMonth, 0).getDate();

  // Monday = 0, Sunday = 6
  const startDayOffset = (firstDayOfMonth.getDay() + 6) % 7;
  const todayStr = new Date().toISOString().split('T')[0];

  // 1. Preceding days from previous month
  for (let i = startDayOffset - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const prevM = currentCalMonth === 0 ? 11 : currentCalMonth - 1;
    const prevY = currentCalMonth === 0 ? currentCalYear - 1 : currentCalYear;
    const dateStr = `${prevY}-${String(prevM + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const cell = createCalendarDayCell(dayNum, dateStr, true, todayStr);
    gridEl.appendChild(cell);
  }

  // 2. Days of current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${currentCalYear}-${String(currentCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = createCalendarDayCell(d, dateStr, false, todayStr);
    gridEl.appendChild(cell);
  }

  // 3. Trailing days from next month to complete row of 7
  const totalCells = startDayOffset + daysInMonth;
  const trailingDays = (7 - (totalCells % 7)) % 7;
  for (let n = 1; n <= trailingDays; n++) {
    const nextM = currentCalMonth === 11 ? 0 : currentCalMonth + 1;
    const nextY = currentCalMonth === 11 ? currentCalYear + 1 : currentCalYear;
    const dateStr = `${nextY}-${String(nextM + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    const cell = createCalendarDayCell(n, dateStr, true, todayStr);
    gridEl.appendChild(cell);
  }
}

function createCalendarDayCell(dayNum, dateStr, isOtherMonth, todayStr) {
  const cell = document.createElement('div');
  cell.className = 'cal-day-cell';
  cell.dataset.date = dateStr;

  if (isOtherMonth) cell.classList.add('is-other-month');
  if (dateStr === todayStr) cell.classList.add('is-today');
  if (dateStr === selectedCalDate) cell.classList.add('is-selected');

  cell.onclick = () => selectCalendarDate(dateStr);

  const header = document.createElement('div');
  header.className = 'day-cell-top';
  header.innerHTML = `<span class="day-number">${dayNum}</span>`;
  cell.appendChild(header);

  const badgesContainer = document.createElement('div');
  badgesContainer.className = 'day-badges-container';

  // Events for this date
  const eventsForDay = calendarEvents.filter(e => e.date === dateStr);
  eventsForDay.slice(0, 2).forEach(ev => {
    const b = document.createElement('span');
    b.className = 'day-badge badge-event';
    b.title = `Event: ${ev.title} (${ev.start_time || 'All Day'})`;
    b.textContent = `📅 ${ev.title}`;
    badgesContainer.appendChild(b);
  });

  // Tasks for this date
  const tasksForDay = calendarTasks.filter(t => t.due_date === dateStr && t.status !== 'completed' && t.status !== 'cancelled');
  tasksForDay.slice(0, 2).forEach(t => {
    const b = document.createElement('span');
    b.className = 'day-badge badge-task';
    b.title = `Task: ${t.title} [${t.status}]`;
    b.textContent = `🔔 ${t.title}`;
    badgesContainer.appendChild(b);
  });

  // Contact Birthdays / Anniversaries (MM-DD match)
  const monthDay = dateStr.slice(5); // 'MM-DD'
  const bdays = contactImportantDates.filter(c => {
    const bMatch = c.birthday && (c.birthday === monthDay || c.birthday.endsWith(monthDay));
    const aMatch = c.anniversary && (c.anniversary === monthDay || c.anniversary.endsWith(monthDay));
    return bMatch || aMatch;
  });
  bdays.slice(0, 1).forEach(c => {
    const b = document.createElement('span');
    b.className = 'day-badge badge-bday';
    b.title = `Birthday / Anniversary: ${c.name}`;
    b.textContent = `🎂 ${c.name}`;
    badgesContainer.appendChild(b);
  });

  const totalBadges = eventsForDay.length + tasksForDay.length + bdays.length;
  if (totalBadges > 4) {
    const more = document.createElement('span');
    more.className = 'badge-more';
    more.textContent = `+${totalBadges - 4} more`;
    badgesContainer.appendChild(more);
  }

  cell.appendChild(badgesContainer);
  return cell;
}

function renderSelectedDayDetails(dateStr) {
  const container = document.getElementById('cal-selected-day-items');
  const dateHeading = document.getElementById('cal-selected-date-text');
  const countBadge = document.getElementById('cal-selected-date-items-count');
  if (!container) return;

  const dateObj = new Date(dateStr + 'T00:00:00');
  const dateFormatted = dateObj.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  if (dateHeading) dateHeading.textContent = `Selected: ${dateFormatted}`;

  const events = calendarEvents.filter(e => e.date === dateStr);
  const tasks = calendarTasks.filter(t => t.due_date === dateStr);
  const monthDay = dateStr.slice(5);
  const bdays = contactImportantDates.filter(c => {
    const bMatch = c.birthday && (c.birthday === monthDay || c.birthday.endsWith(monthDay));
    const aMatch = c.anniversary && (c.anniversary === monthDay || c.anniversary.endsWith(monthDay));
    return bMatch || aMatch;
  });

  const total = events.length + tasks.length + bdays.length;
  if (countBadge) countBadge.textContent = `${total} item${total === 1 ? '' : 's'}`;

  if (total === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 12px; font-size: 13px;">
        No events or tasks scheduled for this day.
        <div style="margin-top: 8px; display: flex; gap: 8px;">
          <button class="btn btn-secondary btn-sm" onclick="openAddEventModal('${dateStr}')">+ Event</button>
          <button class="btn btn-primary btn-sm" onclick="openAddTaskModal('${dateStr}')">+ Task</button>
        </div>
      </div>`;
    return;
  }

  let html = '';

  // Render Birthdays
  bdays.forEach(c => {
    html += `
      <div class="selected-day-item item-bday">
        <span class="item-icon">🎂</span>
        <div class="item-info">
          <div class="item-title">${escapeHtml(c.name)}'s Special Day</div>
          <div class="item-sub">Birthday / Anniversary celebration · Phone: ${escapeHtml(c.phone_number || '')}</div>
        </div>
      </div>`;
  });

  // Render Events
  events.forEach(ev => {
    const timeStr = ev.start_time ? `${ev.start_time}${ev.end_time ? ' - ' + ev.end_time : ''}` : 'All Day';
    html += `
      <div class="selected-day-item item-event">
        <span class="item-icon">📅</span>
        <div class="item-info">
          <div class="item-title">${escapeHtml(ev.title)}</div>
          <div class="item-sub">${escapeHtml(timeStr)}${ev.location ? ' · 📍 ' + escapeHtml(ev.location) : ''}</div>
          ${ev.description ? `<div class="item-note">${escapeHtml(ev.description)}</div>` : ''}
        </div>
        <div class="item-actions">
          <button class="btn-icon-sm" title="Delete Event" onclick="handleDeleteEvent('${ev.id}')">🗑️</button>
        </div>
      </div>`;
  });

  // Render Tasks
  tasks.forEach(t => {
    const statusClass = t.status === 'completed' ? 'text-accent' : (t.status === 'snoozed' ? 'text-warning' : '');
    const requester = t.requester_name ? `${t.requester_name} (${t.requester_canonical_id || ''})` : 'Owner';
    html += `
      <div class="selected-day-item item-task ${t.status === 'completed' ? 'is-done' : ''}">
        <span class="item-icon">🔔</span>
        <div class="item-info">
          <div class="item-title">${escapeHtml(t.title)}</div>
          <div class="item-sub">
            <span class="status-badge ${t.status}">${t.status.toUpperCase()}</span>
            ${t.due_time ? '⏰ ' + escapeHtml(t.due_time) + ' · ' : ''}
            Requested by: ${escapeHtml(requester)}
          </div>
          ${t.description ? `<div class="item-note">${escapeHtml(t.description)}</div>` : ''}
        </div>
        <div class="item-actions">
          ${t.status === 'pending' || t.status === 'snoozed' ? `
            <button class="btn btn-secondary btn-sm" onclick="handleCompleteTask('${t.id}')">✓ Done</button>
            <button class="btn btn-secondary btn-sm" onclick="handleSnoozeTask('${t.id}')">⏰ +1h</button>
          ` : `
            <button class="btn btn-secondary btn-sm" onclick="handleReopenTask('${t.id}')">Reopen</button>
          `}
          <button class="btn-icon-sm" title="Delete Task" onclick="handleDeleteTask('${t.id}')">🗑️</button>
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

function setTaskFilter(filter) {
  currentTaskFilter = filter;
  document.querySelectorAll('.task-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.taskFilter === filter);
  });
  renderTasksList();
}

function renderTasksList() {
  const container = document.getElementById('tasks-list-container');
  const countBadge = document.getElementById('pending-tasks-count');
  if (!container) return;

  const pendingCount = calendarTasks.filter(t => t.status === 'pending').length;
  if (countBadge) countBadge.textContent = `${pendingCount} pending`;

  let filtered = calendarTasks;
  if (currentTaskFilter === 'pending') {
    filtered = calendarTasks.filter(t => t.status === 'pending');
  } else if (currentTaskFilter === 'completed') {
    filtered = calendarTasks.filter(t => t.status === 'completed');
  } else if (currentTaskFilter === 'snoozed') {
    filtered = calendarTasks.filter(t => t.status === 'snoozed');
  }

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: 16px; font-size: 13px;">No ${currentTaskFilter} tasks found.</div>`;
    return;
  }

  let html = '';
  filtered.forEach(t => {
    const isCompleted = t.status === 'completed';
    const requester = t.requester_name || (t.requester_contact_id ? t.requester_contact_id : 'Owner');
    const dueStr = t.due_date ? `${t.due_date}${t.due_time ? ' at ' + t.due_time : ''}` : 'No due date';

    html += `
      <div class="task-card ${isCompleted ? 'task-card-done' : ''}">
        <div class="task-card-header">
          <div class="task-card-title-row">
            <span class="task-status-dot status-${t.status}"></span>
            <span class="task-card-title">${escapeHtml(t.title)}</span>
          </div>
          <span class="task-pill-status ${t.status}">${t.status}</span>
        </div>

        <div class="task-card-meta">
          <span>📅 ${escapeHtml(dueStr)}</span>
          <span>👤 ${escapeHtml(requester)}</span>
        </div>

        ${t.description ? `<div class="task-card-desc">${escapeHtml(t.description)}</div>` : ''}

        <div class="task-card-actions">
          ${!isCompleted ? `
            <button class="btn btn-secondary btn-sm" onclick="handleCompleteTask('${t.id}')">✓ Complete</button>
            <button class="btn btn-secondary btn-sm" onclick="handleSnoozeTask('${t.id}')">⏰ Snooze 1h</button>
          ` : `
            <button class="btn btn-secondary btn-sm" onclick="handleReopenTask('${t.id}')">↺ Reopen</button>
          `}
          <button class="btn btn-secondary btn-sm btn-danger-hover" onclick="handleDeleteTask('${t.id}')">🗑️ Delete</button>
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

function renderContactDatesList() {
  const container = document.getElementById('contact-dates-container');
  if (!container) return;

  const validDates = contactImportantDates.filter(c => c.birthday || c.anniversary || (c.important_dates && c.important_dates.length > 0));

  if (validDates.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: 12px; font-size: 12px;">No contact birthdays or anniversaries recorded yet.</div>`;
    return;
  }

  let html = '';
  validDates.forEach(c => {
    html += `
      <div class="contact-date-row">
        <div style="font-weight: 600; color: #fff; font-size: 13px;">${escapeHtml(c.name)}</div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
          ${c.birthday ? `🎂 Birthday: <strong style="color: var(--text-primary);">${escapeHtml(c.birthday)}</strong> · ` : ''}
          ${c.anniversary ? `💍 Anniversary: <strong style="color: var(--text-primary);">${escapeHtml(c.anniversary)}</strong>` : ''}
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

// --- Task & Event Actions ---
async function handleCompleteTask(taskId) {
  try {
    await fetch(`/api/tasks/${taskId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' })
    });
    await loadCalendarData();
  } catch (err) {
    alert('Failed to update task: ' + err.message);
  }
}

async function handleReopenTask(taskId) {
  try {
    await fetch(`/api/tasks/${taskId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' })
    });
    await loadCalendarData();
  } catch (err) {
    alert('Failed to reopen task: ' + err.message);
  }
}

async function handleSnoozeTask(taskId) {
  try {
    await fetch(`/api/tasks/${taskId}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: 60 })
    });
    await loadCalendarData();
  } catch (err) {
    alert('Failed to snooze task: ' + err.message);
  }
}

async function handleDeleteTask(taskId) {
  if (!confirm('Are you sure you want to delete this task?')) return;
  try {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    await loadCalendarData();
  } catch (err) {
    alert('Failed to delete task: ' + err.message);
  }
}

async function handleDeleteEvent(eventId) {
  if (!confirm('Are you sure you want to delete this calendar event?')) return;
  try {
    await fetch(`/api/calendar/events/${eventId}`, { method: 'DELETE' });
    await loadCalendarData();
  } catch (err) {
    alert('Failed to delete event: ' + err.message);
  }
}

// --- Task Modal ---
function openAddTaskModal(prefillDate) {
  const modal = document.getElementById('modal-task-edit');
  if (!modal) return;

  const dateInput = document.getElementById('task-input-date');
  const titleInput = document.getElementById('task-input-title');
  const descInput = document.getElementById('task-input-desc');
  const reqSelect = document.getElementById('task-input-requester');

  if (titleInput) titleInput.value = '';
  if (descInput) descInput.value = '';
  if (dateInput) dateInput.value = prefillDate || selectedCalDate || new Date().toISOString().split('T')[0];

  if (reqSelect) {
    let opts = '<option value="Owner" selected>Owner (Self)</option>';
    if (Array.isArray(currentContacts)) {
      currentContacts.forEach(c => {
        opts += `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.phone_number || c.id)})</option>`;
      });
    }
    reqSelect.innerHTML = opts;
  }

  modal.classList.remove('hidden');
}

function closeTaskModal() {
  const modal = document.getElementById('modal-task-edit');
  if (modal) modal.classList.add('hidden');
}

async function handleSaveTask() {
  const title = document.getElementById('task-input-title')?.value?.trim();
  const dueDate = document.getElementById('task-input-date')?.value;
  const dueTime = document.getElementById('task-input-time')?.value;
  const requesterVal = document.getElementById('task-input-requester')?.value;
  const desc = document.getElementById('task-input-desc')?.value?.trim();

  if (!title) {
    alert('Please enter a task title.');
    return;
  }

  let requesterContactId = null;
  let requesterName = 'Owner';
  let requesterCanonical = null;

  if (requesterVal && requesterVal !== 'Owner') {
    requesterContactId = requesterVal;
    const contact = currentContacts.find(c => c.id === requesterVal);
    if (contact) {
      requesterName = contact.name;
      requesterCanonical = contact.whatsapp_phone_id || contact.phone_number || contact.id;
    }
  }

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: desc,
        dueDate,
        dueTime,
        requesterContactId,
        requesterName,
        requesterCanonicalId: requesterCanonical,
        ownerId: 'Owner'
      })
    });
    const json = await res.json();
    if (json.success) {
      closeTaskModal();
      await loadCalendarData();
    } else {
      alert('Error saving task: ' + (json.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Failed to save task: ' + err.message);
  }
}

// --- Event Modal ---
function openAddEventModal(prefillDate) {
  const modal = document.getElementById('modal-event-edit');
  if (!modal) return;

  const titleInput = document.getElementById('event-input-title');
  const dateInput = document.getElementById('event-input-date');
  const locInput = document.getElementById('event-input-location');
  const descInput = document.getElementById('event-input-desc');

  if (titleInput) titleInput.value = '';
  if (locInput) locInput.value = '';
  if (descInput) descInput.value = '';
  if (dateInput) dateInput.value = prefillDate || selectedCalDate || new Date().toISOString().split('T')[0];

  modal.classList.remove('hidden');
}

function closeEventModal() {
  const modal = document.getElementById('modal-event-edit');
  if (modal) modal.classList.add('hidden');
}

async function handleSaveEvent() {
  const title = document.getElementById('event-input-title')?.value?.trim();
  const date = document.getElementById('event-input-date')?.value;
  const startTime = document.getElementById('event-input-start')?.value;
  const endTime = document.getElementById('event-input-end')?.value;
  const location = document.getElementById('event-input-location')?.value?.trim();
  const desc = document.getElementById('event-input-desc')?.value?.trim();

  if (!title || !date) {
    alert('Please enter event title and date.');
    return;
  }

  try {
    const res = await fetch('/api/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        date,
        startTime,
        endTime,
        location,
        description: desc,
        isAllDay: !startTime
      })
    });
    const json = await res.json();
    if (json.success) {
      closeEventModal();
      await loadCalendarData();
    } else {
      alert('Error saving event: ' + (json.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Failed to save event: ' + err.message);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightSearchMatch(text, query) {
  if (!text) return '';
  if (!query || !query.trim()) return escapeHtml(text);
  const cleanQ = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${cleanQ})`, 'gi');
  const escaped = escapeHtml(text);
  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
}

