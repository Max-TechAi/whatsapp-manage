// e:\work\Project_Files\testwhats\src\public\js\dashboard.js

let token = localStorage.getItem('token') || '';
let ws = null;
let activeSessionId = '';
let activeChatId = ''; // Remote JID
let activeChatDbId = ''; // Database Chat ID
let chats = [];
let messagesMap = {}; // cache messages by JID
let qrPollInterval = null;
let currentQrSessionId = null;
let contactsMap = {};
let lidMappings = {};
let processedMessageIds = new Set();

let userRole = 'agent';
let userHasAllSessionsAccess = false;
let userDisplayName = '';

// ─── DESKTOP NOTIFICATIONS MODULE ────────────────────────────
// Tracks whether the prompt has been dismissed this session so we don't re-show it.
let notifPromptDismissed = sessionStorage.getItem('notif_prompt_dismissed') === '1';
let notifBlockedDismissed = sessionStorage.getItem('notif_blocked_dismissed') === '1';

/**
 * Called on page load. Checks the current Notification API permission state
 * and shows the appropriate UI banner (prompt / blocked / nothing).
 * Does NOT call requestPermission() automatically — requires a user gesture.
 */
function initNotifications() {
  if (!('Notification' in window)) return; // Browser doesn't support notifications

  const perm = Notification.permission;

  if (perm === 'granted') {
    // Already granted — nothing to do, notifications work silently.
    return;
  }

  if (perm === 'denied') {
    // User has explicitly blocked notifications. Show a dismissible warning once.
    if (!notifBlockedDismissed) {
      document.getElementById('notifBlockedBanner').style.display = 'flex';
    }
    return;
  }

  // perm === 'default' — not yet asked. Show a non-intrusive prompt.
  if (!notifPromptDismissed) {
    document.getElementById('notifPromptBanner').style.display = 'flex';
  }
}

/**
 * Called when the user clicks the "Enable" button on the prompt banner.
 * Requests permission (requires user gesture — this click IS the gesture).
 */
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;

  // Hide the prompt immediately to avoid double-clicks
  document.getElementById('notifPromptBanner').style.display = 'none';

  const result = await Notification.requestPermission();
  if (result === 'granted') {
    // Optionally fire a brief "test" notification to confirm it's working
    new Notification('✅ Notifications enabled', {
      body: 'You will now receive desktop alerts for new WhatsApp messages.',
      icon: '/img/wa-icon.png',
      tag: 'notif-test',
      silent: true,
    });
  } else if (result === 'denied') {
    // They changed their mind and denied — show the blocked banner
    if (!notifBlockedDismissed) {
      document.getElementById('notifBlockedBanner').style.display = 'flex';
    }
  }
}

/** Dismiss the permission prompt for this browser session. */
function dismissNotifPrompt() {
  notifPromptDismissed = true;
  sessionStorage.setItem('notif_prompt_dismissed', '1');
  document.getElementById('notifPromptBanner').style.display = 'none';
}

/** Dismiss the "blocked" warning banner for this browser session. */
function dismissNotifBlocked() {
  notifBlockedDismissed = true;
  sessionStorage.setItem('notif_blocked_dismissed', '1');
  document.getElementById('notifBlockedBanner').style.display = 'none';
}

/**
 * Returns a human-readable preview string for a message object,
 * suitable for both the desktop notification body and chat list preview.
 *
 * Priority: deleted → message-type emoji → text content (truncated).
 * @param {object} message - The message object from the WebSocket event.
 * @returns {string}
 */
function getMessagePreviewText(message) {
  if (!message) return '';

  if (message.isDeleted) return '🚫 This message was deleted';

  const type = message.messageType || 'text';

  switch (type) {
    case 'image':    return '📷 Photo';
    case 'video':    return '🎬 Video';
    case 'audio': {
      // Distinguish between voice notes (ptt) and regular audio files
      const isPtt = message.metadata?.ptt === true ||
        (message.mediaMimeType && message.mediaMimeType.includes('ogg'));
      return isPtt ? '🎤 Voice message' : '🎵 Audio';
    }
    case 'document': return `📄 ${message.content || 'Document'}`;
    case 'sticker':  return '🎭 Sticker';
    case 'location': return '📍 Location';
    case 'contact':  return '👤 Contact';
    case 'reaction': return `${message.content || '👍'} Reaction`;
    case 'poll':     return `📊 ${message.content || 'Poll'}`;
    default: {
      const text = message.content || '';
      return text.length > 100 ? text.substring(0, 100) + '…' : text;
    }
  }
}

/**
 * Resolves the best display name for a chat object, reusing the same
 * priority chain used for the chat list: pushName → saved contact name
 * → chat.name → formatted phone number.
 * @param {object} chatObj - A chat entry from the in-memory `chats` array.
 * @returns {string}
 */
function getChatDisplayName(chatObj) {
  if (!chatObj) return 'Unknown';

  const jid = chatObj.waChatId || '';
  const phone = jid.split('@')[0];

  // Resolve via contactsMap (same lookup used in renderChatsList)
  const fromContacts = contactsMap[jid] || contactsMap[phone];
  if (fromContacts) return fromContacts;

  // Fall back to the chat's own name field
  if (chatObj.name) return chatObj.name;

  return formatPhoneNumberFallback(phone) || jid;
}

/**
 * Plays a brief notification sound using the Web Audio API.
 * Generates a simple two-tone "ding" — no external file required.
 * Silently fails if audio is blocked by the browser.
 */
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    // First tone
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.frequency.value = 880;  // A5
    gain1.gain.setValueAtTime(0.18, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc1.start(now);
    osc1.stop(now + 0.18);

    // Second tone (slightly higher, delayed)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.frequency.value = 1100; // C#6
    gain2.gain.setValueAtTime(0.12, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.32);

    // Close audio context after sound finishes to free resources
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 400);
  } catch (err) {
    // Web Audio not supported or blocked — fail silently
    console.debug('Notification sound unavailable:', err.message);
  }
}

/**
 * Creates and shows a native OS desktop notification for a new inbound message.
 *
 * Rules:
 *  - Only fires for inbound messages (fromMe === false).
 *  - Only fires when Notification.permission === 'granted'.
 *  - Uses tag = chatDbId so rapid bursts from the SAME chat replace each other,
 *    but bursts from DIFFERENT chats each get their own notification.
 *  - Clicking the notification focuses the window and opens that chat.
 *
 * TODO: Check per-chat mute settings before showing notification, once
 *       per-chat mute/DND settings are implemented in the backend.
 *
 * @param {object} message  - The message object from the WebSocket event data.
 * @param {object} chatObj  - The matching entry from the in-memory `chats` array.
 * @param {string} chatDbId - The database UUID of the chat (used as notification tag).
 */
function showDesktopNotification(message, chatObj, chatDbId) {
  // Guard: browser must support Notifications
  if (!('Notification' in window)) return;
  // Guard: permission must be granted
  if (Notification.permission !== 'granted') return;
  // Guard: must be an inbound message (not sent by us)
  if (message && (message.fromMe === true)) return;

  const title = getChatDisplayName(chatObj);
  const body  = getMessagePreviewText(message);

  const notif = new Notification(title, {
    body,
    // Use chat avatar if available; fall back to a generic WhatsApp icon.
    icon: chatObj?.avatarUrl || '/img/wa-icon.png',
    // tag: same-chat notifications replace each other instead of stacking.
    tag: chatDbId || (chatObj?.id) || 'wa-msg',
    // renotify: show animation/sound for each replacement even with same tag.
    renotify: true,
  });

  // Clicking the notification: bring window to front and open that chat.
  notif.onclick = () => {
    window.focus();
    if (chatDbId && chatObj) {
      const displayName = getChatDisplayName(chatObj);
      selectChat(chatDbId, chatObj.waChatId, displayName);
    }
    notif.close();
  };

  // Play a subtle notification sound
  playNotificationSound();
}

// Auth Guard on start
if (!token) {
  document.getElementById('authWarning').style.display = 'block';
  setTimeout(() => {
    window.location.href = '/';
  }, 2000);
} else {
  // Decode JWT to get display name and role
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    userRole = payload.role || 'agent';
    userHasAllSessionsAccess = !!payload.hasAllSessionsAccess;
    userDisplayName = payload.displayName || payload.email || 'Agent';
    document.getElementById('headerUserName').textContent = userDisplayName;

    // Show team settings tab link for admin
    if (userRole === 'admin') {
      const navBtnTeam = document.getElementById('navBtnTeam');
      if (navBtnTeam) navBtnTeam.style.display = 'flex';
    }
  } catch (e) {
    console.error('Failed to parse token payload', e);
  }

  // Connect WebSocket & Init data
  connectWS();
  initDashboard();
}

function initDashboard() {
  loadSessions();
  loadWebhooks();
  if (userRole === 'admin') {
    loadTeamMembers();
  }
  // Initialize desktop notification permission state (shows prompt or blocked banner as needed)
  initNotifications();
}

// ─── TAB NAVIGATION ───────────────────────────────────────────
function switchTab(tabId) {
  const tabs = document.querySelectorAll('.tab-content');
  const navLinks = document.querySelectorAll('.nav-link');
  
  tabs.forEach(tab => {
    tab.classList.remove('active');
  });
  
  navLinks.forEach(link => {
    link.classList.remove('active');
  });

  document.getElementById(`tab-${tabId}`).classList.add('active');
  
  // Activate correct nav button
  if (tabId === 'inbox') document.getElementById('navBtnInbox').classList.add('active');
  if (tabId === 'sessions') document.getElementById('navBtnSessions').classList.add('active');
  if (tabId === 'webhooks') document.getElementById('navBtnWebhooks').classList.add('active');
  if (tabId === 'team') document.getElementById('navBtnTeam').classList.add('active');

  // Reload data context
  if (tabId === 'sessions') loadSessions();
  if (tabId === 'webhooks') loadWebhooks();
  if (tabId === 'team') loadTeamMembers();
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────
async function loadSessions() {
  try {
    const response = await fetch('/api/sessions', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to load sessions');

    const sessions = resData.data || [];
    populateSessionDropdowns(sessions);
    renderSessionsTable(sessions);
  } catch (err) {
    console.error(err);
    logTerminal('ERROR', err.message);
  }
}

function populateSessionDropdowns(sessions) {
  const dropdown = document.getElementById('inboxSessionSelect');
  const connected = sessions.filter(s => s.status === 'connected');

  if (connected.length === 0) {
    dropdown.innerHTML = '<option value="">-- No connected devices --</option>';
    activeSessionId = '';
    hideSyncOverlay();

    if (userRole === 'agent' && sessions.length === 0) {
      const chatsContainer = document.getElementById('chatsListContainer');
      if (chatsContainer) {
        chatsContainer.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; height: 100%; padding: 2rem; color: var(--text-muted);">
            <p style="font-weight: 500; font-size: 1rem; margin-bottom: 0.5rem;">⚠️ No WhatsApp Devices</p>
            <p style="font-size: 0.9rem; line-height: 1.4;">You don't have access to any WhatsApp numbers yet. Please contact your administrator.</p>
          </div>
        `;
      }
    }
    return;
  }

  const previousSelection = dropdown.value;
  dropdown.innerHTML = '<option value="">-- Select active device --</option>' + 
    connected.map(s => `<option value="${s.id}">${s.sessionName} (${s.phoneNumber || 'Unlinked'})</option>`).join('');

  if (previousSelection && connected.some(s => s.id === previousSelection)) {
    dropdown.value = previousSelection;
    activeSessionId = previousSelection;
  } else {
    // Auto-select first connected session on load
    dropdown.value = connected[0].id;
    activeSessionId = connected[0].id;
    handleInboxSessionChange();
  }
}

function renderSessionsTable(sessions) {
  const tableBody = document.getElementById('sessionsListBody');
  if (sessions.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          No sessions found. Link a new WhatsApp device above.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = sessions.map(s => {
    let statusClass = 'badge-status';
    if (s.status === 'connected') statusClass += ' connected';
    else if (s.status === 'connecting') statusClass += ' connecting';
    else if (s.status === 'qr_pending') statusClass += ' qr_pending';
    else statusClass += ' disconnected';

    const showQrButton = s.status === 'qr_pending' || s.status === 'initializing' || s.status === 'disconnected';

    return `
      <tr>
        <td style="font-weight: 500;">${escapeHtml(s.sessionName)}</td>
        <td><code>${s.phoneNumber || 'Pending Scan'}</code></td>
        <td style="font-size: 0.8rem; color: var(--text-muted);"><code>${s.id}</code></td>
        <td><span class="${statusClass}">${s.status.toUpperCase()}</span></td>
        <td>
          <div style="display: flex; gap: 0.5rem;">
            ${showQrButton ? `<button onclick="openQrModal('${s.id}', '${escapeHtml(s.sessionName)}')" class="btn" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">Get QR</button>` : ''}
            <button onclick="restartSession('${s.id}')" class="btn btn-secondary" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">Restart</button>
            <button onclick="deleteSession('${s.id}')" class="btn btn-danger" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleCreateSession(e) {
  e.preventDefault();
  const nameInput = document.getElementById('sessionNameInput');
  const sessionName = nameInput.value.trim();
  if (!sessionName) return;

  try {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ sessionName })
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to create session');

    nameInput.value = '';
    loadSessions();
    
    // Automatically open QR modal for pairing
    openQrModal(resData.data.id, resData.data.sessionName);
  } catch (err) {
    alert(err.message);
  }
}

async function restartSession(sessionId) {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/restart`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Failed to restart');
    }
    loadSessions();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteSession(sessionId) {
  if (!confirm('Are you sure you want to permanently delete this session? This removes all active connections.')) return;
  try {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Failed to delete');
    }
    loadSessions();
  } catch (err) {
    alert(err.message);
  }
}

// ─── QR MODAL LIFE ────────────────────────────────────────────
function openQrModal(sessionId, sessionName) {
  currentQrSessionId = sessionId;
  document.getElementById('qrModalTitle').textContent = `Link ${sessionName}`;
  document.getElementById('qrModalImage').src = '';
  document.getElementById('qrModalStatus').textContent = 'Generating QR code...';
  document.getElementById('qrModalOverlay').classList.add('active');

  // Load immediately
  checkQrConnectionStatus();
  
  // Start polling
  if (qrPollInterval) clearInterval(qrPollInterval);
  qrPollInterval = setInterval(checkQrConnectionStatus, 3000);
}

function closeQrModal() {
  document.getElementById('qrModalOverlay').classList.remove('active');
  if (qrPollInterval) {
    clearInterval(qrPollInterval);
    qrPollInterval = null;
  }
  currentQrSessionId = null;
  loadSessions();
}

async function checkQrConnectionStatus() {
  if (!currentQrSessionId || currentQrSessionId === 'null' || currentQrSessionId === 'undefined') return;

  try {
    const response = await fetch(`/api/sessions/${currentQrSessionId}/qr`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.status === 204) {
      // Connected or QR not ready yet
      const sessionResponse = await fetch(`/api/sessions/${currentQrSessionId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const sessionData = await sessionResponse.json();
      const status = sessionData.data.status;

      if (status === 'connected') {
        document.getElementById('qrModalStatus').textContent = '✅ WhatsApp Connected Successfully!';
        document.getElementById('qrModalStatus').style.color = 'var(--accent-green)';
        setTimeout(closeQrModal, 1500);
      } else {
        document.getElementById('qrModalStatus').textContent = 'Waiting for WhatsApp backend initialization...';
      }
      return;
    }

    const resData = await response.json();
    if (resData.success && resData.data.qr) {
      document.getElementById('qrModalImage').src = resData.data.qr;
      document.getElementById('qrModalStatus').textContent = 'Waiting for scan...';
      document.getElementById('qrModalStatus').style.color = 'var(--accent-blue)';
    }
  } catch (err) {
    console.error('Error checking QR code', err);
  }
}

// ─── INBOX / CHAT MANAGEMENT ──────────────────────────────────
function handleInboxSessionChange() {
  activeSessionId = document.getElementById('inboxSessionSelect').value;
  activeChatId = '';
  activeChatDbId = '';
  document.getElementById('chatsListContainer').innerHTML = '';
  document.getElementById('chatPlaceholder').style.display = 'flex';
  document.getElementById('activeChatWrapper').style.display = 'none';
  contactsMap = {};
  lidMappings = {};
  
  if (activeSessionId) {
    checkInitialSyncStatus(activeSessionId);
    loadLidMappingsForSession().then(() => {
      loadChats();
      loadContactsForSession();
    });
  } else {
    hideSyncOverlay();
  }
}

async function loadChats() {
  if (!activeSessionId) return;

  try {
    const response = await fetch(`/api/chats?sessionId=${activeSessionId}&limit=50`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to load chats');

    chats = resData.chats || [];
    renderChatsList(chats);
  } catch (err) {
    console.error(err);
  }
}

function renderChatsList(chatList) {
  try {
    const container = document.getElementById('chatsListContainer');
    
    // EXCLUDE: Exclude WhatsApp Status broadcast and official Channel/Newsletter threads
    const filteredList = (chatList || []).filter(c => 
      c.waChatId !== 'status@broadcast' && 
      c.waChatId !== 'status' && 
      !c.waChatId.endsWith('@broadcast') && 
      !c.waChatId.endsWith('@newsletter')
    );

    if (filteredList.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 2rem 1rem; font-size: 0.9rem;">
          No chats synchronized yet. Start a new chat from WhatsApp.
        </div>
      `;
      return;
    }

    // Sort conversations by most recent message activity (lastMessageAt DESC or fallback to createdAt), pinned first
    const sortedList = [...filteredList].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return timeB - timeA;
    });

    container.innerHTML = sortedList.map(c => {
      const isActive = c.waChatId === activeChatId ? 'active' : '';
      const avatarIcon = c.chatType === 'group' ? '👥' : '👤';
      const lastMsg = c.lastMessagePreview || '<i>No messages</i>';
      const timestamp = c.lastMessageAt ? formatTime(new Date(c.lastMessageAt)) : '';
      
      // Show numeric unread badge count
      const hasUnread = typeof c.unreadCount !== 'undefined' && c.unreadCount !== null && Number(c.unreadCount) > 0;
      const unread = hasUnread ? `<span class="chat-badge" title="${c.unreadCount} unread messages">${c.unreadCount}</span>` : '';
      
      // Fallback phone number formatted with '+'
      const displayName = formatPhoneNumberFallback(c.name || c.waChatId.split('@')[0]);

      return `
        <div class="chat-item ${isActive}" onclick="selectChat('${c.id}', '${c.waChatId}', '${escapeHtml(displayName)}')">
          <div class="chat-avatar">${avatarIcon}</div>
          <div class="chat-info">
            <div class="chat-header-row">
              <span class="chat-name">${escapeHtml(displayName)}</span>
              <span class="chat-time">${timestamp}</span>
            </div>
            <div class="chat-meta-row">
              <span class="chat-preview">${lastMsg}</span>
              ${unread}
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to render chat list:', err);
    document.getElementById('chatsListContainer').innerHTML = `<div style="color: var(--danger); padding: 1rem; font-size: 0.85rem;">Error loading chats</div>`;
  }
}

async function selectChat(chatDbId, waChatJid, chatName) {
  activeChatId = waChatJid;
  activeChatDbId = chatDbId;
  
  // Highlight active chat item
  const chatItems = document.querySelectorAll('.chat-item');
  chatItems.forEach(item => item.classList.remove('active'));
  
  // Set headers
  document.getElementById('activeChatName').textContent = chatName;
  document.getElementById('activeChatJid').textContent = waChatJid;
  document.getElementById('activeChatAvatar').textContent = waChatJid.endsWith('@g.us') ? '👥' : '👤';

  // Toggle wrap
  document.getElementById('chatPlaceholder').style.display = 'none';
  document.getElementById('activeChatWrapper').style.display = 'flex';

  // Toggle assignee select display based on user role
  if (userRole === 'admin') {
    document.getElementById('assignChatContainer').style.display = 'flex';
    await loadEligibleAssignees(chatDbId);
  } else {
    document.getElementById('assignChatContainer').style.display = 'none';
  }

  // Load message history
  await loadMessages(chatDbId);
}

async function loadMessages(chatDbId, silent = false) {
  const container = document.getElementById('messagesContainer');
  if (!silent) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Loading chat history...</div>';
  }

  try {
    const response = await fetch(`/api/messages/chats/${chatDbId}/messages?limit=100`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to load messages');

    const messages = resData.messages || [];
    renderMessages(messages);
  } catch (err) {
    container.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 1.5rem;">Error: ${err.message}</div>`;
  }
}

function renderMessages(msgList) {
  const container = document.getElementById('messagesContainer');
  if (msgList.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Send a message to start conversation.</div>';
    return;
  }

  try {
    // Messages in DB are sorted newest first, reverse to show chronologically
    const sorted = [...msgList].reverse();

    container.innerHTML = sorted.map(m => {
      try {
        const isSelf = m.fromMe;
        const bubbleClass = isSelf ? 'message-bubble self' : 'message-bubble other';
        const time = formatTime(new Date(m.createdAt));
        
        // Status ticks for self messages
        let statusTick = '';
        if (isSelf) {
          if (m.status === 'read') statusTick = '<span style="color: #4fc3f7;">✓✓</span>';
          else if (m.status === 'delivered') statusTick = '<span>✓✓</span>';
          else if (m.status === 'sent') statusTick = '<span>✓</span>';
        }

        // Attribution for self messages
        let attributionHtml = '';
        if (isSelf) {
          if (m.sentByUserId) {
            attributionHtml = `<div class="message-attribution" style="font-size: 0.65rem; color: rgba(255,255,255,0.45); text-align: right; margin-top: 0.2rem; font-style: italic;">Sent by: ${escapeHtml(m.sentByDisplayName || 'Unknown Agent')}</div>`;
          } else {
            attributionHtml = `<div class="message-attribution" style="font-size: 0.65rem; color: rgba(255,255,255,0.45); text-align: right; margin-top: 0.2rem; font-style: italic;">Sent from phone</div>`;
          }
        }

        // Render group sender name above bubble if not from self in group chat
        let senderHeader = '';
        if (!isSelf && activeChatId.endsWith('@g.us')) {
          const displayName = getSenderDisplayName(m.senderJid, m.metadata?.pushName);
          senderHeader = `<div class="message-sender" style="font-size: 0.75rem; font-weight: 600; color: #4fc3f7; margin-bottom: 0.2rem; cursor: default;">${escapeHtml(displayName)}</div>`;
        }

        // Render message body (handles text content vs media files)
        let bodyHtml = '';
        if (m.isDeleted) {
          bodyHtml = `<span style="font-style: italic; color: rgba(255,255,255,0.4); display: inline-flex; align-items: center; gap: 0.25rem;">🚫 This message was deleted</span>`;
        } else if (m.metadata?.decryptionFailed) {
          bodyHtml = `
            <div class="decryption-failed-container" style="display: flex; flex-direction: column; gap: 0.4rem; padding: 0.25rem 0;">
              <div style="display: flex; align-items: center; gap: 0.5rem; color: #ffab40; font-style: italic; font-size: 0.85rem; line-height: 1.4;">
                <span>⏳ Waiting for this message. This may take a while.</span>
                <span class="tooltip-icon" style="display: inline-block; cursor: pointer; color: rgba(255,255,255,0.5); font-style: normal; font-size: 0.75rem; background: rgba(255,255,255,0.1); width: 15px; height: 15px; border-radius: 50%; text-align: center; line-height: 15px; font-weight: bold; flex-shrink: 0;" title="If the recipient's phone has been offline or their security keys changed, your chat session might get out of sync. Resetting the session will force WhatsApp to establish a new secure channel. Any new messages sent after resetting will decrypt properly.">?</span>
              </div>
              <button onclick="resetContactSession(event, '${m.senderJid}')" class="session-reset-btn" style="align-self: flex-start; background: rgba(255,171,64,0.1); border: 1px solid rgba(255,171,64,0.25); color: #ffab40; font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 4px; cursor: pointer; outline: none; transition: all 0.2s; font-weight: 500; margin-top: 2px;" onmouseover="this.style.background='rgba(255,171,64,0.2)'" onmouseout="this.style.background='rgba(255,171,64,0.1)'">Reset Session</button>
            </div>
          `;
        } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(m.messageType)) {
          if (m.metadata?.mediaStatus === 'failed') {
            // BUG 6: Handle download failures gracefully with a retry and a "media unavailable" fallback UI
            bodyHtml = `
              <div class="media-failed-container" style="display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0;">
                <span style="color: #ff5252; font-style: italic; font-size: 0.85rem;">⚠️ Media unavailable</span>
                <button onclick="retryMediaDownload(event, '${m.id}')" class="media-retry-btn" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: var(--text-normal); font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; cursor: pointer; outline: none; transition: background 0.2s;">Retry</button>
              </div>
            `;
          } else if (m.metadata?.mediaFileId) {
            const mediaUrl = `/api/media/${m.metadata.mediaFileId}?token=${token}`;
            if (m.messageType === 'image' || m.messageType === 'sticker') {
              bodyHtml = `<div class="media-container"><img src="${mediaUrl}" class="chat-image" alt="Image" style="max-width: 250px; border-radius: 8px; margin-top: 5px; cursor: pointer;" onclick="window.open('${mediaUrl}', '_blank')"/></div>`;
            } else if (m.messageType === 'video') {
              bodyHtml = `<div class="media-container"><video src="${mediaUrl}" controls class="chat-video" style="max-width: 300px; border-radius: 8px; margin-top: 5px;"></video></div>`;
            } else if (m.messageType === 'audio') {
              const isVoiceNote = m.metadata?.ptt === true || (m.mediaMimeType && m.mediaMimeType.includes('ogg')) || m.mediaMimeType === 'audio/ogg';
              if (isVoiceNote) {
                bodyHtml = `
                  <div class="media-container voice-note-container" style="display: flex; align-items: center; gap: 0.75rem; background: rgba(255,255,255,0.05); padding: 0.5rem 0.75rem; border-radius: 12px; margin-top: 5px; min-width: 240px;">
                    <button onclick="toggleVoiceNotePlay(this)" class="vn-play-btn" style="background: var(--accent-green); color: #0b0f19; border: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 0.8rem; flex-shrink: 0; outline: none;">▶</button>
                    <div style="flex: 1; display: flex; flex-direction: column; gap: 0.2rem;">
                      <!-- Waveform visualization -->
                      <div class="vn-waveform" style="display: flex; align-items: center; gap: 2px; height: 16px;">
                        <span style="height: 40%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 60%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 30%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 80%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 50%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 70%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 90%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 40%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 60%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 30%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 80%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 50%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 70%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 90%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 40%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                        <span style="height: 60%; width: 2px; background: rgba(255,255,255,0.4); border-radius: 1px; transition: background 0.1s;"></span>
                      </div>
                      <div style="font-size: 0.65rem; color: var(--text-muted); display: flex; justify-content: space-between;">
                        <span>Voice Note</span>
                        <span class="vn-duration">--:--</span>
                      </div>
                    </div>
                    <audio ontimeupdate="updateVnProgress(this)" onloadedmetadata="initVnDuration(this)" style="display: none;">
                      <source src="${mediaUrl}" type="audio/ogg; codecs=opus">
                      <source src="/api/media/${m.metadata.mediaFileId}/transcode?token=${token}" type="audio/mpeg">
                    </audio>
                  </div>
                `;
              } else {
                bodyHtml = `
                  <div class="media-container">
                    <audio src="${mediaUrl}" controls class="chat-audio" style="margin-top: 5px;"></audio>
                  </div>
                `;
              }
            } else if (m.messageType === 'document') {
              bodyHtml = `<div class="media-container"><a href="${mediaUrl}" target="_blank" class="chat-document" style="display: inline-flex; align-items: center; gap: 0.5rem; text-decoration: none; color: #4fc3f7; font-weight: 500; margin-top: 5px;">📄 Download ${escapeHtml(m.content || 'Document')}</a></div>`;
            }
          } else {
            const isOld = (Date.now() - new Date(m.createdAt).getTime()) > 60000; // 1 minute
            if (isOld) {
              bodyHtml = `
                <div class="media-download-container" style="display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0;">
                  <span style="color: var(--text-muted); font-style: italic; font-size: 0.85rem;">⏳ Media not downloaded</span>
                  <button onclick="retryMediaDownload(event, '${m.id}')" class="media-retry-btn" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: var(--text-normal); font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; cursor: pointer; outline: none; transition: background 0.2s;">Download</button>
                </div>
              `;
            } else {
              bodyHtml = `<div style="font-style: italic; color: var(--text-muted); padding: 0.25rem 0;">⏳ Media is downloading...</div>`;
            }
          }
        } else {
          bodyHtml = formatMessageContent(m.content || '');
        }

        const editedLabel = m.isEdited ? '<span style="font-size: 0.65rem; color: rgba(255,255,255,0.4); margin-right: 0.25rem;">Edited</span>' : '';

        return `
          <div class="${bubbleClass}">
            ${senderHeader}
            ${bodyHtml}
            ${attributionHtml}
            <div class="message-meta">
              ${editedLabel}
              <span>${time}</span>
              ${statusTick}
            </div>
          </div>
        `;
      } catch (err) {
        console.error('Error rendering individual message:', err);
        return `<div class="message-bubble other" style="color: var(--danger);">[Failed to render message]</div>`;
      }
    }).join('');

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.error('Critical failure inside renderMessages:', err);
    container.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 1.5rem;">⚠️ Error rendering messages. Please refresh page.</div>`;
  }
}

async function handleSendMessageSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('dashboardMessageInput');
  const body = input.value.trim();
  if (!body || !activeSessionId || !activeChatId) return;

  // Clear input
  input.value = '';

  // Append local message bubble immediately for UX
  appendLocalBubble(body);

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        sessionId: activeSessionId,
        recipientJid: activeChatId,
        body
      })
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to send');

    // Mark chat as read since we replied
    if (activeChatDbId) {
      markChatAsRead(activeChatDbId);
    }
  } catch (err) {
    console.error(err);
    logTerminal('ERROR', `Send failed: ${err.message}`);
  }
}

function appendLocalBubble(text) {
  const container = document.getElementById('messagesContainer');
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble self';
  bubble.style.opacity = '0.7'; // dimmed till sent
  bubble.innerHTML = `
    ${escapeHtml(text)}
    <div class="message-meta">
      <span>${formatTime(new Date())}</span>
      <span>⌛</span>
    </div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

async function markChatAsRead(chatDbId) {
  try {
    await fetch(`/api/chats/${chatDbId}/read`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    // Quietly reload chats list to update badge
    loadChats();
  } catch (err) {
    console.error('Failed to mark chat as read', err);
  }
}

function handleChatSearch() {
  const query = document.getElementById('chatSearchInput').value.toLowerCase();
  const filtered = chats.filter(c => {
    const name = (c.name || c.waChatId.split('@')[0]).toLowerCase();
    return name.includes(query) || c.waChatId.toLowerCase().includes(query);
  });
  renderChatsList(filtered);
}

// ─── WEBHOOK MANAGEMENT ───────────────────────────────────────
async function loadWebhooks() {
  try {
    const response = await fetch('/api/webhooks', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to load webhooks');

    const webhooksList = resData.data || [];
    renderWebhooksTable(webhooksList);
  } catch (err) {
    console.error(err);
  }
}

function renderWebhooksTable(webhooksList) {
  const tableBody = document.getElementById('webhooksListBody');
  if (webhooksList.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
          No webhooks configured. Create one below.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = webhooksList.map(w => {
    const eventsStr = (w.events || []).join(', ');
    const statusText = w.isActive ? 'Active' : 'Disabled';
    const statusClass = w.isActive ? 'badge-status connected' : 'badge-status disconnected';

    return `
      <tr>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <code style="font-size: 0.85rem;">${escapeHtml(w.url)}</code>
        </td>
        <td style="font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(eventsStr)}</td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td>
          <button onclick="deleteWebhook('${w.id}')" class="btn btn-danger" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleSaveWebhook(e) {
  e.preventDefault();
  const url = document.getElementById('webhookUrl').value.trim();
  const eventCheckboxes = document.querySelectorAll('input[name="webhookEvents"]:checked');
  const events = Array.from(eventCheckboxes).map(cb => cb.value);

  if (!url || events.length === 0) {
    alert('Please provide Webhook URL and select at least one event type.');
    return;
  }

  try {
    const response = await fetch('/api/webhooks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ url, events })
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to save webhook');

    document.getElementById('webhookUrl').value = '';
    loadWebhooks();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteWebhook(webhookId) {
  if (!confirm('Are you sure you want to delete this webhook subscription?')) return;
  try {
    const response = await fetch(`/api/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Failed to delete');
    }
    loadWebhooks();
  } catch (err) {
    alert(err.message);
  }
}

// ─── WEBSOCKET CLIENT BINDING ──────────────────────────────────
function connectWS() {
  if (!token) return;
  if (ws) ws.close();

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.host;
  const wsUrl = `${wsProtocol}//${wsHost}/ws?token=${token}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    document.getElementById('wsStatusDot').className = 'status-dot connected';
    document.getElementById('wsStatusText').textContent = 'WebSocket Online';
    document.getElementById('reconnectingBanner').style.display = 'none';
  };

  ws.onclose = () => {
    document.getElementById('wsStatusDot').className = 'status-dot disconnected';
    document.getElementById('wsStatusText').textContent = 'WebSocket Offline';
    if (isHistorySyncCompleted && activeSessionId) {
      document.getElementById('reconnectingBanner').style.display = 'block';
    }
    // Reconnect after 3s
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket Error:', error);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  };
}

function handleWsEvent(data) {
  const { type, sessionId, orgId } = data;

  // Sync event handlers
  if (activeSessionId === sessionId) {
    if (type === 'sync:progress') {
      if (isHistorySyncCompleted) return; // Prevent overlay from popping back up if sync already completed!
      const { syncProcessedMessages, syncTotalMessages, syncStatus } = data;
      showSyncOverlay(syncStatus, syncProcessedMessages, syncTotalMessages);
      return;
    }
    if (type === 'sync:completed') {
      hideSyncOverlay();
      isHistorySyncCompleted = true;
      loadChats();
      return;
    }
    if (type === 'sync:failed') {
      showSyncOverlay('failed', 0, 0, data.reason || 'Sync failed.');
      return;
    }
  }

  // Real-time message receiver (maps new_message trigger and other inbound events)
  if (type === 'message:new' || type === 'message:received' || type === 'message:sent') {
    const msgChatId = data.chatId || data.data?.chatId;

    if (activeSessionId === sessionId && msgChatId) {
      // BUG 1: Deduplicate message processing using a Set of processed message IDs
      const msgId = data.message?.waMessageId || data.waMessageId || data.message?.id || data.id;
      let isDuplicate = false;
      if (msgId) {
        if (processedMessageIds.has(msgId)) {
          isDuplicate = true;
        } else {
          processedMessageIds.add(msgId);
        }
      }

      console.log('[DEBUG UNREAD] WS message event received:', {
        type,
        msgChatId,
        msgId,
        isDuplicate,
        fromMe: data.fromMe || data.message?.fromMe || false
      });

      // In-memory array update for instant chat list updates & sorting
      const chatObj = chats.find(c => c.id === msgChatId || c.waChatId === msgChatId);
      if (chatObj) {
        chatObj.lastMessageAt = data.createdAt || data.message?.createdAt || new Date().toISOString();
        if (data.message?.content) {
          chatObj.lastMessagePreview = data.message.content;
        } else if (data.content) {
          chatObj.lastMessagePreview = data.content;
        }
        
        const isFromMe = data.fromMe || data.message?.fromMe || false;
        if (isFromMe) {
          console.log('[DEBUG UNREAD] Resetting unread count to 0 in chatObj due to fromMe message', { msgChatId, oldVal: chatObj.unreadCount });
          chatObj.unreadCount = 0; // Reset count since we replied!
        } else if (!isDuplicate) {
          // Increment unread count for every new inbound message that is not a duplicate
          const oldVal = chatObj.unreadCount;
          chatObj.unreadCount = (Number(chatObj.unreadCount) || 0) + 1;
          console.log('[DEBUG UNREAD] Incrementing unread count in chatObj', { msgChatId, oldVal, newVal: chatObj.unreadCount });

          // Show a desktop notification for new INBOUND messages (only on message:new, not status/media updates)
          if (type === 'message:new' && !isDuplicate) {
            showDesktopNotification(data.message || data, chatObj, msgChatId);
          }
        } else {
          console.log('[DEBUG UNREAD] Skipping unread increment because it is a duplicate message', { msgChatId, msgId });
        }
        renderChatsList(chats);
      } else {
        console.log('[DEBUG UNREAD] Chat object not found in chats array, calling loadChats()', { msgChatId });
        // Fallback: reload chats list from server
        loadChats();
      }

      // If we are currently chatting with this contact, reload messages silently
      if (activeChatDbId === msgChatId) {
        loadMessages(activeChatDbId, true);
      }
    }
  }

  // Handle media and status updates separately to avoid duplicate counts or incorrect resets
  if (type === 'message:media_update' || type === 'message:status_update') {
    const msgChatId = data.chatId || data.data?.chatId;
    if (activeSessionId === sessionId && msgChatId) {
      // If we are currently chatting with this contact, reload messages silently to update checkmarks/media
      if (activeChatDbId === msgChatId) {
        loadMessages(activeChatDbId, true);
      }
    }
  }

  /* BUG 3: Handle in-memory updating, sorting, and re-rendering on chat updates (e.g. from Baileys) */
  if (type === 'chat:update' || type === 'chat:updated') {
    const updatedChat = data.chat;
    if (activeSessionId === sessionId && updatedChat) {
      const index = chats.findIndex(c => c.id === updatedChat.id || c.waChatId === updatedChat.waChatId);
      if (index !== -1) {
        // Merge updated properties, preserving current unread count unless explicitly read (0)
        const oldUnreadCount = chats[index].unreadCount;
        console.log('[DEBUG UNREAD] WS chat:update event received for existing chat', {
          chatId: updatedChat.id,
          waChatId: updatedChat.waChatId,
          oldUnreadCount,
          incomingUnreadCount: updatedChat.unreadCount
        });
        chats[index] = { ...chats[index], ...updatedChat };
        if (updatedChat.unreadCount !== 0) {
          console.log('[DEBUG UNREAD] WS chat:update preserving oldUnreadCount because incoming is non-zero', {
            chatId: updatedChat.id,
            oldUnreadCount,
            incomingUnreadCount: updatedChat.unreadCount
          });
          chats[index].unreadCount = oldUnreadCount;
        }
      } else {
        console.log('[DEBUG UNREAD] WS chat:update event received for NEW chat', {
          chatId: updatedChat.id,
          waChatId: updatedChat.waChatId,
          incomingUnreadCount: updatedChat.unreadCount
        });
        // Insert new chat if it doesn't exist locally
        chats.push(updatedChat);
      }
      renderChatsList(chats);
    }
  }

  // Session Connection status updates
  if (type === 'session:status') {
    loadSessions();
    if (currentQrSessionId === sessionId) {
      checkQrConnectionStatus();
    }
  }
}

// ─── HELPER UTILS ──────────────────────────────────────────────
async function loadLidMappingsForSession() {
  if (!activeSessionId) return;
  try {
    const response = await fetch(`/api/sessions/${activeSessionId}/lid-mappings`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (response.ok && resData.data) {
      lidMappings = resData.data;
    }
  } catch (err) {
    console.error('Failed to load LID mappings:', err);
  }
}

async function loadContactsForSession() {
  if (!activeSessionId) return;
  try {
    const response = await fetch(`/api/contacts?sessionId=${activeSessionId}&limit=1000`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (response.ok && resData.contacts) {
      contactsMap = {};
      resData.contacts.forEach(c => {
        const name = c.displayName || (c.pushName ? `~${c.pushName}` : null) || c.phoneNumber || c.waId.split('@')[0];
        contactsMap[c.waId] = name;
        const phone = c.waId.split('@')[0];
        contactsMap[phone] = name;
        if (c.phoneNumber) {
          contactsMap[c.phoneNumber] = name;
        }
      });
      // If a chat is already open, reload messages to resolve names instantly
      if (activeChatDbId) {
        loadMessages(activeChatDbId);
      }
    }
  } catch (err) {
    console.error('Failed to load contacts for mentions:', err);
  }
}

function getSenderDisplayName(senderJid, pushNameMetadata) {
  let resolvedJid = senderJid;
  if (resolvedJid.endsWith('@lid') && lidMappings[resolvedJid]) {
    resolvedJid = lidMappings[resolvedJid];
  }
  
  const contactName = contactsMap[resolvedJid] || contactsMap[resolvedJid.split('@')[0]];
  if (contactName) {
    return contactName;
  }
  
  if (pushNameMetadata) {
    return `~${pushNameMetadata}`;
  }
  
  const phone = resolvedJid.split('@')[0];
  return formatPhoneNumberFallback(phone);
}

function formatMessageContent(content) {
  if (!content) return '';
  let formatted = escapeHtml(content);
  // Replace mentions (e.g. @905384534139 or @31083399782580@lid) with contact name/pushname
  formatted = formatted.replace(/@(\d+)(?:@s\.whatsapp\.net|@lid)?/g, (match, id) => {
    let lookupKey = id;
    const lidJid = id + '@lid';
    if (lidMappings[lidJid]) {
      const phoneJid = lidMappings[lidJid];
      lookupKey = phoneJid.split('@')[0];
    }
    
    const contactName = contactsMap[lookupKey] 
      || contactsMap[lookupKey + '@s.whatsapp.net']
      || contactsMap[id]
      || contactsMap[lidJid];
      
    if (contactName) {
      return `<span style="color: #3b82f6; font-weight: 600;">@${escapeHtml(contactName)}</span>`;
    }
    return match;
  });
  return formatted;
}

function formatPhoneNumberFallback(name) {
  if (!name) return '';
  // If it is a LID JID user part (usually 15 digits starting with 11, 31, 51, etc.)
  if (name.length === 15 && /^(?:11|31|51)/.test(name)) {
    return 'LID ' + name;
  }
  // If name is just digits (like user part of JID), prepend +
  if (/^\d+$/.test(name)) {
    return '+' + name;
  }
  return name;
}

function toggleVoiceNotePlay(btn) {
  try {
    const container = btn.closest('.voice-note-container');
    const audio = container.querySelector('audio');
    if (audio.paused) {
      // Pause all other audio elements playing
      document.querySelectorAll('audio').forEach(a => {
        if (a !== audio) {
          a.pause();
          const otherBtn = a.closest('.voice-note-container')?.querySelector('.vn-play-btn');
          if (otherBtn) otherBtn.textContent = '▶';
        }
      });
      audio.play().then(() => {
        btn.textContent = '⏸';
      }).catch(err => console.error('Play failed', err));
    } else {
      audio.pause();
      btn.textContent = '▶';
    }
  } catch (err) {
    console.error('Error toggling voice note play:', err);
  }
}

function initVnDuration(audio) {
  try {
    const container = audio.closest('.voice-note-container');
    const durationSpan = container.querySelector('.vn-duration');
    if (audio.duration && !isNaN(audio.duration)) {
      const minutes = Math.floor(audio.duration / 60);
      const seconds = Math.floor(audio.duration % 60);
      durationSpan.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }
  } catch (err) {
    console.error('Error loading audio duration:', err);
  }
}

function updateVnProgress(audio) {
  try {
    const container = audio.closest('.voice-note-container');
    const durationSpan = container.querySelector('.vn-duration');
    const playBtn = container.querySelector('.vn-play-btn');
    
    if (audio.ended) {
      playBtn.textContent = '▶';
    }
    
    const current = audio.currentTime;
    const total = audio.duration || 0;
    
    if (total > 0) {
      const minutes = Math.floor(current / 60);
      const seconds = Math.floor(current % 60);
      durationSpan.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
      
      // Waveform highlight effect
      const bars = container.querySelectorAll('.vn-waveform span');
      const percent = current / total;
      const highlightCount = Math.floor(bars.length * percent);
      bars.forEach((bar, idx) => {
        if (idx < highlightCount) {
          bar.style.background = 'var(--accent-green)';
        } else {
          bar.style.background = 'rgba(255,255,255,0.4)';
        }
      });
    }
  } catch (err) {
    console.error('Error updating audio progress:', err);
  }
}
// BUG 6: Handle media download retries from UI
async function retryMediaDownload(evt, messageId) {
  try {
    const btn = evt.target;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Retrying...';
    }

    const response = await fetch(`/api/media/messages/${messageId}/retry`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
      if (activeChatDbId) {
        await loadMessages(activeChatDbId);
      }
    } else {
      const data = await response.json();
      alert(data.error || 'Failed to retry media download');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    }
  } catch (err) {
    console.error('Failed to retry media download:', err);
    alert('An error occurred while retrying download');
  }
}

async function resetContactSession(evt, contactJid) {
  evt.stopPropagation();
  if (!activeSessionId) {
    alert('No active session selected.');
    return;
  }
  
  const btn = evt.target;
  const originalText = btn.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Resetting...';
  }

  try {
    const response = await fetch(`/api/sessions/${activeSessionId}/reset-contact-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ contactJid })
    });

    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to reset session');

    alert('Successfully reset session for contact. A new secure channel will establish when they send a new message or when you reply.');
    if (btn) {
      btn.textContent = 'Reset!';
    }
    setTimeout(() => {
      if (btn) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }, 2000);
  } catch (err) {
    console.error('Failed to reset contact session:', err);
    alert(`Error: ${err.message}`);
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
}
window.resetContactSession = resetContactSession;

function handleLogout() {
  localStorage.removeItem('token');
  window.location.href = '/';
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function logTerminal(topic, message) {
  console.log(`[${topic}] ${message}`);
}

// ─── INITIAL SYNC LOCK OVERLAY & STATUS TRACKING ──────────────

let isHistorySyncCompleted = false;

async function checkInitialSyncStatus(sessionId) {
  if (!sessionId || sessionId === 'null' || sessionId === 'undefined') return;
  try {
    const response = await fetch(`/api/sessions/${sessionId}/sync-status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Failed to fetch sync status');

    const resData = await response.json();
    const { syncStatus, syncProcessedMessages, syncTotalMessages, historySyncCompleted } = resData.data;

    isHistorySyncCompleted = historySyncCompleted;

    if (!historySyncCompleted && (syncStatus === 'pending' || syncStatus === 'syncing')) {
      showSyncOverlay(syncStatus, syncProcessedMessages, syncTotalMessages);
    } else if (!historySyncCompleted && syncStatus === 'failed') {
      showSyncOverlay('failed');
    } else {
      hideSyncOverlay();
    }
  } catch (err) {
    console.error('Error checking sync status:', err);
  }
}

function showSyncOverlay(status, processed = 0, total = 0, errorMsg = '') {
  try {
    const overlay = document.getElementById('syncLockOverlay');
    if (!overlay) return;

    overlay.style.display = 'flex';

    const progressBar = document.getElementById('syncProgressBar');
    const progressText = document.getElementById('syncProgressText');
    const errorContainer = document.getElementById('syncErrorContainer');
    const errorText = document.getElementById('syncErrorText');

    if (status === 'failed') {
      progressBar.classList.remove('indeterminate');
      progressBar.style.width = '0%';
      progressText.style.display = 'none';
      
      errorContainer.style.display = 'block';
      errorText.textContent = errorMsg || 'Sync failed. Retry to resume.';
    } else {
      errorContainer.style.display = 'none';
      progressText.style.display = 'block';

      if (total > 0) {
        progressBar.classList.remove('indeterminate');
        const percent = Math.min(100, Math.floor((processed / total) * 100));
        progressBar.style.width = `${percent}%`;
        progressText.textContent = `Syncing your conversations... ${processed.toLocaleString()} / ${total.toLocaleString()} messages synced (${percent}%)`;
      } else {
        progressBar.classList.add('indeterminate');
        progressBar.style.width = '100%';
        if (processed > 0) {
          progressText.textContent = `Syncing your conversations... ${processed.toLocaleString()} messages synced...`;
        } else {
          progressText.textContent = 'Syncing your conversations for the first time. This may take a few minutes.';
        }
      }
    }
  } catch (err) {
    console.error('Error rendering sync overlay:', err);
    hideSyncOverlay();
  }
}

function hideSyncOverlay() {
  const overlay = document.getElementById('syncLockOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

async function handleSyncRetry() {
  if (!activeSessionId || activeSessionId === 'null' || activeSessionId === 'undefined') return;

  const errorContainer = document.getElementById('syncErrorContainer');
  const progressText = document.getElementById('syncProgressText');
  const progressBar = document.getElementById('syncProgressBar');
  const retryBtn = document.getElementById('syncRetryBtn');

  try {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying...';

    const response = await fetch(`/api/sessions/${activeSessionId}/sync-retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Failed to trigger sync retry');
    }

    // Reset UI to indeterminate syncing state
    errorContainer.style.display = 'none';
    progressText.style.display = 'block';
    progressText.textContent = 'Reinitializing sync...';
    progressBar.classList.add('indeterminate');
    progressBar.style.width = '100%';

    // Wait a brief moment to reload sessions list
    setTimeout(loadSessions, 1500);
  } catch (err) {
    alert(err.message);
  } finally {
    retryBtn.disabled = false;
    retryBtn.textContent = 'Retry Sync';
  }
}

// ─── TEAM MANAGEMENT & ASSIGNMENT MODULE ──────────────────────────

let teamMembers = [];
let allOrgSessions = [];

async function loadEligibleAssignees(chatDbId) {
  try {
    const response = await fetch(`/api/chats/${chatDbId}/eligible-assignees`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Failed to load eligible assignees');
    const res = await response.json();
    
    const select = document.getElementById('chatAssigneeSelect');
    const users = res.data || [];
    
    select.innerHTML = '<option value="">Unassigned</option>' +
      users.map(u => `<option value="${u.id}">${escapeHtml(u.displayName || u.email)}</option>`).join('');
    
    const chatObj = chats.find(c => c.id === chatDbId);
    if (chatObj && chatObj.assignedToUserId) {
      select.value = chatObj.assignedToUserId;
    } else {
      select.value = '';
    }
  } catch (err) {
    console.error('Failed to load eligible assignees:', err);
  }
}

async function handleAssignChatChange() {
  const select = document.getElementById('chatAssigneeSelect');
  const assignedUserId = select.value || null;
  
  try {
    const response = await fetch(`/api/chats/${activeChatDbId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ userId: assignedUserId })
    });
    
    if (!response.ok) {
      const res = await response.json();
      throw new Error(res.error || 'Failed to assign chat');
    }
    
    const chatObj = chats.find(c => c.id === activeChatDbId);
    if (chatObj) {
      chatObj.assignedToUserId = assignedUserId;
    }
    
    logTerminal('INFO', `Chat assigned successfully to ${assignedUserId || 'Unassigned'}`);
  } catch (err) {
    alert(err.message);
    const chatObj = chats.find(c => c.id === activeChatDbId);
    select.value = (chatObj && chatObj.assignedToUserId) ? chatObj.assignedToUserId : '';
  }
}

async function loadTeamMembers() {
  try {
    const response = await fetch('/api/orgs/members', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to load team members');

    teamMembers = resData.members || [];
    renderTeamMembersTable(teamMembers);
  } catch (err) {
    console.error(err);
  }
}

function renderTeamMembersTable(members) {
  const tableBody = document.getElementById('teamListBody');
  if (members.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
          No team members found.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = members.map(m => {
    const statusText = m.isActive ? '<span class="badge-status connected">ACTIVE</span>' : '<span class="badge-status disconnected">INACTIVE</span>';
    return `
      <tr>
        <td style="font-weight: 500;">${escapeHtml(m.displayName || '')}</td>
        <td><code>${escapeHtml(m.email)}</code></td>
        <td><span class="badge-status connecting" style="text-transform: uppercase;">${m.role}</span></td>
        <td>${statusText}</td>
        <td>
          <div style="display: flex; gap: 0.5rem;">
            <button onclick="openTeamModal('${m.id}')" class="btn" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">Edit</button>
            <button onclick="removeTeamMember('${m.id}')" class="btn btn-secondary" style="padding: 0.35rem 0.75rem; font-size: 0.8rem; color: var(--danger); border-color: var(--danger);">Remove</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleInviteMember(e) {
  e.preventDefault();
  const emailInput = document.getElementById('inviteEmail');
  const roleSelect = document.getElementById('inviteRole');
  const btn = e.target.querySelector('button[type="submit"]');

  try {
    btn.disabled = true;
    btn.textContent = 'Inviting...';

    const response = await fetch('/api/orgs/members', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        email: emailInput.value.trim(),
        role: roleSelect.value
      })
    });

    const resData = await response.json();
    if (!response.ok) throw new Error(resData.error || 'Failed to invite member');

    emailInput.value = '';
    roleSelect.value = 'agent';
    alert('Member invited successfully!');
    loadTeamMembers();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Invite Member';
  }
}

async function removeTeamMember(userId) {
  if (userId === JSON.parse(atob(token.split('.')[1])).userId) {
    alert('You cannot remove yourself');
    return;
  }
  if (!confirm('Are you sure you want to remove this team member?')) return;

  try {
    const response = await fetch(`/api/orgs/members/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      const res = await response.json();
      throw new Error(res.error || 'Failed to remove member');
    }

    alert('Member removed successfully');
    loadTeamMembers();
  } catch (err) {
    alert(err.message);
  }
}

async function openTeamModal(userId) {
  const member = teamMembers.find(m => m.id === userId);
  if (!member) return;

  document.getElementById('editUserId').value = userId;
  document.getElementById('editDisplayName').value = member.displayName || '';
  document.getElementById('editRole').value = member.role;
  document.getElementById('editIsActive').checked = member.isActive;

  // Load org sessions list
  try {
    const response = await fetch('/api/sessions', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const resData = await response.json();
    if (response.ok) {
      allOrgSessions = resData.data || [];
    }
  } catch (err) {
    console.error('Failed to load org sessions:', err);
  }

  // Load current permissions for this member
  let permissions = { hasAllSessionsAccess: false, sessionIds: [] };
  try {
    const response = await fetch(`/api/orgs/members/${userId}/permissions`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (response.ok) {
      permissions = await response.json();
    }
  } catch (err) {
    console.error('Failed to fetch permissions:', err);
  }

  document.getElementById('editAllSessionsAccess').checked = permissions.hasAllSessionsAccess;

  // Populate checkboxes
  const group = document.getElementById('specificSessionsGroup');
  group.innerHTML = allOrgSessions.map(s => {
    const checked = permissions.sessionIds.includes(s.id) ? 'checked' : '';
    return `
      <label style="display: flex; align-items: center; gap: 0.5rem; font-weight: normal; cursor: pointer; color: var(--text-main); font-size: 0.9rem;">
        <input type="checkbox" class="specific-session-checkbox" value="${s.id}" ${checked}> ${escapeHtml(s.sessionName)} (${s.phoneNumber || 'Unlinked'})
      </label>
    `;
  }).join('');

  toggleEditRoleSettings();
  document.getElementById('teamModalOverlay').classList.add('active');
}

function closeTeamModal() {
  document.getElementById('teamModalOverlay').classList.remove('active');
}

function toggleEditRoleSettings() {
  const role = document.getElementById('editRole').value;
  const note = document.getElementById('adminSessionsNote');
  const checkboxContainer = document.getElementById('editAllSessionsAccess').closest('.input-group');
  const group = document.getElementById('specificSessionsGroup');

  if (role === 'admin') {
    note.style.display = 'block';
    checkboxContainer.style.display = 'none';
    group.style.display = 'none';
  } else {
    note.style.display = 'none';
    checkboxContainer.style.display = 'block';
    group.style.display = 'flex';
    toggleAllSessionsCheckbox();
  }
}

function toggleAllSessionsCheckbox() {
  const allSessionsChecked = document.getElementById('editAllSessionsAccess').checked;
  const checkboxes = document.querySelectorAll('.specific-session-checkbox');
  checkboxes.forEach(cb => {
    cb.disabled = allSessionsChecked;
    if (allSessionsChecked) {
      cb.checked = false;
    }
  });
}

async function handleSaveMember(e) {
  e.preventDefault();
  const userId = document.getElementById('editUserId').value;
  const displayName = document.getElementById('editDisplayName').value.trim();
  const role = document.getElementById('editRole').value;
  const isActive = document.getElementById('editIsActive').checked;
  const hasAllSessionsAccess = document.getElementById('editAllSessionsAccess').checked;

  const btn = e.target.querySelector('button[type="submit"]');

  try {
    btn.disabled = true;
    btn.textContent = 'Saving...';

    // 1. Update basic details
    const patchRes = await fetch(`/api/orgs/members/${userId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ displayName, role, isActive })
    });

    if (!patchRes.ok) {
      const res = await patchRes.json();
      throw new Error(res.error || 'Failed to update user details');
    }

    // 2. If role is agent, save session permissions
    if (role === 'agent') {
      const checkedBoxes = document.querySelectorAll('.specific-session-checkbox:checked');
      const sessionIds = Array.from(checkedBoxes).map(cb => cb.value);

      const putPermsRes = await fetch(`/api/orgs/members/${userId}/permissions`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ hasAllSessionsAccess, sessionIds })
      });

      if (!putPermsRes.ok) {
        const res = await putPermsRes.json();
        throw new Error(res.error || 'Failed to save session permissions');
      }
    }

    closeTeamModal();
    alert('Member changes saved successfully');
    loadTeamMembers();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

window.handleInviteMember = handleInviteMember;
window.openTeamModal = openTeamModal;
window.closeTeamModal = closeTeamModal;
window.removeTeamMember = removeTeamMember;
window.toggleEditRoleSettings = toggleEditRoleSettings;
window.toggleAllSessionsCheckbox = toggleAllSessionsCheckbox;
window.handleSaveMember = handleSaveMember;
window.handleAssignChatChange = handleAssignChatChange;
