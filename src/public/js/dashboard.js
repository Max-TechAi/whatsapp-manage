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

// Auth Guard on start
if (!token) {
  document.getElementById('authWarning').style.display = 'block';
  setTimeout(() => {
    window.location.href = '/';
  }, 2000);
} else {
  // Decode JWT to get display name
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    document.getElementById('headerUserName').textContent = payload.displayName || payload.email || 'Agent';
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

  // Reload data context
  if (tabId === 'sessions') loadSessions();
  if (tabId === 'webhooks') loadWebhooks();
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
    return;
  }

  const previousSelection = dropdown.value;
  dropdown.innerHTML = '<option value="">-- Select active device --</option>' + 
    connected.map(s => `<option value="${s.id}">${s.sessionName} (${s.phoneNumber || 'Unlinked'})</option>`).join('');

  if (previousSelection && connected.some(s => s.id === previousSelection)) {
    dropdown.value = previousSelection;
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
  if (!currentQrSessionId) return;

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
  
  if (activeSessionId) {
    loadChats();
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
  const container = document.getElementById('chatsListContainer');
  if (chatList.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 2rem 1rem; font-size: 0.9rem;">
        No chats synchronized yet. Start a new chat from WhatsApp.
      </div>
    `;
    return;
  }

  container.innerHTML = chatList.map(c => {
    const isActive = c.waChatId === activeChatId ? 'active' : '';
    const avatarIcon = c.chatType === 'group' ? '👥' : '👤';
    const lastMsg = c.lastMessagePreview || '<i>No messages</i>';
    const timestamp = c.lastMessageAt ? formatTime(new Date(c.lastMessageAt)) : '';
    const unread = c.unreadCount > 0 ? `<span class="chat-badge">${c.unreadCount}</span>` : '';

    return `
      <div class="chat-item ${isActive}" onclick="selectChat('${c.id}', '${c.waChatId}', '${escapeHtml(c.name || c.waChatId.split('@')[0])}')">
        <div class="chat-avatar">${avatarIcon}</div>
        <div class="chat-info">
          <div class="chat-header-row">
            <span class="chat-name">${escapeHtml(c.name || c.waChatId.split('@')[0])}</span>
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

  // Load message history
  await loadMessages(chatDbId);
  
  // Mark chat as read in backend
  markChatAsRead(chatDbId);
}

async function loadMessages(chatDbId) {
  const container = document.getElementById('messagesContainer');
  container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Loading chat history...</div>';

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

  // Messages in DB are sorted newest first, reverse to show chronologically
  const sorted = [...msgList].reverse();

  container.innerHTML = sorted.map(m => {
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

    return `
      <div class="${bubbleClass}">
        ${escapeHtml(m.content || '')}
        <div class="message-meta">
          <span>${time}</span>
          ${statusTick}
        </div>
      </div>
    `;
  }).join('');

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
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
  };

  ws.onclose = () => {
    document.getElementById('wsStatusDot').className = 'status-dot disconnected';
    document.getElementById('wsStatusText').textContent = 'WebSocket Offline';
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

  // Real-time message receiver
  if (type === 'message:new' || type === 'message:received' || type === 'message:sent') {
    const msgData = data.data?.message;
    const msgChatId = data.data?.chatId; // DB chat ID
    const remoteJid = data.data?.sessionId; // wait, let's verify JID

    // Refresh active session chats list to update preview and unread badges
    if (activeSessionId === sessionId) {
      loadChats();
      
      // If we are currently chatting with this contact, reload messages
      if (activeChatDbId === msgChatId) {
        loadMessages(activeChatDbId);
      }
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
