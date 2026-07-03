/**
 * Developer Console — API reference renderer + Try It executor.
 *
 * NOTE: dev-console.html no longer loads this script (minimal integration guide only).
 * Kept for potential future full-reference UI revival. Manifest: api-endpoints.manifest.json
 */

(function () {
  let manifest = null;

  function getCredentialMode() {
    return sessionStorage.getItem('devConsoleCredMode') || 'jwt';
  }

  function getApiKeyPaste() {
    return sessionStorage.getItem('devConsoleApiKey') || '';
  }

  function buildAuthHeaders() {
    const mode = getCredentialMode();
    if (mode === 'api_key') {
      const key = getApiKeyPaste();
      if (!key) return {};
      return { Authorization: `Bearer ${key}` };
    }
    const jwt = localStorage.getItem('token') || '';
    if (!jwt) return {};
    return { Authorization: `Bearer ${jwt}` };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function authBadge(auth) {
    if (auth === 'none') return '<span class="badge badge-accent">Public</span>';
    if (auth === 'jwt') return '<span class="badge badge-warning">JWT only</span>';
    if (auth === 'both') return '<span class="badge badge-primary">JWT or API Key</span>';
    return `<span class="badge badge-primary">${escapeHtml(auth)}</span>`;
  }

  function renderFieldInput(name, spec, prefix) {
    const id = `${prefix}-${name}`;
    const req = spec.required ? ' required' : '';
    if (spec.type === 'boolean') {
      return `<label><input type="checkbox" id="${id}" data-field="${name}" data-kind="body"> ${escapeHtml(name)}</label>`;
    }
    if (spec.type === 'enum' && spec.options) {
      const opts = spec.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
      return `<div class="input-group"><label>${escapeHtml(name)}</label><select id="${id}" data-field="${name}" data-kind="body"${req}>${opts}</select></div>`;
    }
    if (spec.type === 'json') {
      return `<div class="input-group"><label>${escapeHtml(name)} (JSON)</label><textarea id="${id}" data-field="${name}" data-kind="body" rows="3" placeholder="{}"></textarea></div>`;
    }
    const type = spec.type === 'number' ? 'number' : 'text';
    return `<div class="input-group"><label>${escapeHtml(name)}${spec.required ? ' *' : ''}</label><input type="${type}" id="${id}" data-field="${name}" data-kind="body" placeholder="${escapeHtml(spec.description || '')}"${req}></div>`;
  }

  function renderEndpoint(ep) {
    const bodyFields = ep.body ? Object.entries(ep.body).map(([k, v]) => renderFieldInput(k, v, ep.id)).join('') : '';
    const queryFields = ep.query ? Object.entries(ep.query).map(([k, v]) => {
      const id = `${ep.id}-q-${k}`;
      return `<div class="input-group"><label>${escapeHtml(k)}</label><input type="text" id="${id}" data-field="${k}" data-kind="query"></div>`;
    }).join('') : '';
    const pathFields = ep.pathParams ? Object.entries(ep.pathParams).map(([k, v]) => {
      const id = `${ep.id}-p-${k}`;
      return `<div class="input-group"><label>${escapeHtml(k)} *</label><input type="text" id="${id}" data-field="${k}" data-kind="path" required></div>`;
    }).join('') : '';

    const example = ep.exampleResponse ? `<pre class="doc-pre">${escapeHtml(JSON.stringify(ep.exampleResponse, null, 2))}</pre>` : '';
    const notes = ep.notes ? `<p class="doc-notes">${escapeHtml(ep.notes)}</p>` : '';
    const roles = ep.roles?.length ? `<p class="doc-meta">Roles: ${ep.roles.join(', ')}</p>` : '';

    return `
      <article class="endpoint-card" id="ep-${ep.id}" data-endpoint-id="${ep.id}">
        <div class="endpoint-header">
          <span class="method method-${ep.method.toLowerCase()}">${ep.method}</span>
          <code class="endpoint-path">${escapeHtml(ep.path)}</code>
          ${authBadge(ep.auth || 'both')}
        </div>
        <p class="endpoint-summary">${escapeHtml(ep.summary || '')}</p>
        ${roles}
        ${notes}
        <div class="endpoint-grid">
          <div class="endpoint-docs">
            <h4>Parameters</h4>
            ${pathFields || queryFields || bodyFields ? '' : '<p class="doc-meta">No parameters</p>'}
            ${pathFields ? `<h5>Path</h5>${pathFields}` : ''}
            ${queryFields ? `<h5>Query</h5>${queryFields}` : ''}
            ${bodyFields ? `<h5>Body</h5>${bodyFields}` : ''}
            ${example ? `<h4>Example response</h4>${example}` : ''}
          </div>
          <div class="endpoint-try">
            <h4>Try it</h4>
            ${pathFields}
            ${queryFields}
            ${bodyFields}
            <button type="button" class="btn" onclick="DevConsole.tryEndpoint('${ep.id}')">Send Request</button>
            <pre class="try-result" id="result-${ep.id}">Response will appear here…</pre>
          </div>
        </div>
      </article>
    `;
  }

  function renderQuickStart() {
    const el = document.getElementById('quickStartSection');
    if (!el || !manifest) return;
    const rl = manifest.rateLimits;
    el.innerHTML = `
      <div class="card">
        <div class="card-title">Quick Start</div>
        <p style="color: var(--text-muted); line-height: 1.6; margin-bottom: 1rem;">
          Integrate your CRM or website using a long-lived <strong>API key</strong> (generate under Dashboard → Team → API Keys)
          or a short-lived <strong>JWT</strong> from <code>POST /api/auth/login</code>.
        </p>
        <h4 style="margin: 1rem 0 0.5rem;">Authentication headers</h4>
        <pre class="doc-pre">Authorization: Bearer &lt;accessToken&gt;   # JWT from login
Authorization: Bearer wa_live_...     # API key
X-API-Key: wa_live_...                # API key (alternative)</pre>
        <h4 style="margin: 1rem 0 0.5rem;">Rate limits (default)</h4>
        <ul style="color: var(--text-muted); margin-left: 1.25rem; line-height: 1.8;">
          <li>JWT: ${rl.jwtPerMinute} requests / minute per user</li>
          <li>API key: ${rl.apiKeyPerMinute} requests / minute per key</li>
          <li>Auth endpoints: ${rl.authPer15Min} / 15 min per IP</li>
          <li>WhatsApp sends: ${rl.waMessagesPerMinute} / minute per session</li>
        </ul>
        <h4 style="margin: 1rem 0 0.5rem;">Send a text message (curl)</h4>
        <pre class="doc-pre">curl -X POST "$BASE/api/messages" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"sessionId":"YOUR_SESSION_UUID","recipientJid":"966500000000@s.whatsapp.net","body":"Hello from API"}'</pre>
        <p style="margin-top: 1rem;"><button type="button" class="btn btn-secondary" onclick="DevConsole.scrollToEndpoint('messages-send')">Try POST /api/messages in console →</button></p>
      </div>
    `;
  }

  function renderModuleEndpoints(moduleId, container) {
    const mod = manifest.modules.find((m) => m.id === moduleId);
    if (!mod || !container) return;
    if (moduleId === 'quickstart') {
      renderQuickStart();
      return;
    }
    container.innerHTML = mod.endpoints.map(renderEndpoint).join('');
  }

  function collectEndpointById(id) {
    for (const mod of manifest.modules) {
      const ep = mod.endpoints.find((e) => e.id === id);
      if (ep) return ep;
    }
    return null;
  }

  function buildUrl(ep) {
    let path = ep.path;
    const card = document.getElementById(`ep-${ep.id}`);
    if (!card) return path;
    card.querySelectorAll('[data-kind="path"]').forEach((input) => {
      const field = input.getAttribute('data-field');
      path = path.replace(`:${field}`, encodeURIComponent(input.value.trim()));
    });
    const qs = [];
    card.querySelectorAll('[data-kind="query"]').forEach((input) => {
      const field = input.getAttribute('data-field');
      const val = input.value.trim();
      if (val) qs.push(`${encodeURIComponent(field)}=${encodeURIComponent(val)}`);
    });
    if (qs.length) path += `?${qs.join('&')}`;
    return path;
  }

  function buildBody(ep) {
    if (!ep.body || ep.method === 'GET' || ep.method === 'DELETE') return undefined;
    const card = document.getElementById(`ep-${ep.id}`);
    if (!card) return undefined;
    const obj = {};
    card.querySelectorAll('[data-kind="body"]').forEach((input) => {
      const field = input.getAttribute('data-field');
      if (input.type === 'checkbox') {
        obj[field] = input.checked;
      } else if (input.tagName === 'TEXTAREA' && input.placeholder === '{}') {
        const raw = input.value.trim();
        if (raw) {
          try { obj[field] = JSON.parse(raw); } catch { obj[field] = raw; }
        }
      } else if (input.value.trim()) {
        obj[field] = input.type === 'number' ? Number(input.value) : input.value.trim();
      }
    });
    return Object.keys(obj).length ? JSON.stringify(obj) : undefined;
  }

  async function tryEndpoint(endpointId) {
    const ep = collectEndpointById(endpointId);
    const resultEl = document.getElementById(`result-${endpointId}`);
    if (!ep || !resultEl) return;

    const url = buildUrl(ep);
    const headers = { ...buildAuthHeaders() };
    const opts = { method: ep.method, headers };

    if (ep.auth !== 'none' && !headers.Authorization) {
      resultEl.textContent = 'Error: No credential. Log in or paste an API key in the header bar.';
      return;
    }

    const body = buildBody(ep);
    if (body) {
      headers['Content-Type'] = 'application/json';
      opts.body = body;
    }

    const started = performance.now();
    resultEl.textContent = 'Loading…';
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      let parsed = text;
      try { parsed = JSON.stringify(JSON.parse(text), null, 2); } catch { /* raw */ }
      const ms = Math.round(performance.now() - started);
      const rate = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']
        .map((h) => `${h}: ${res.headers.get(h) ?? '—'}`).join('\n');
      resultEl.textContent = `${res.status} ${res.statusText} (${ms}ms)\n${rate}\n\n${parsed}`;
    } catch (err) {
      resultEl.textContent = `Request failed: ${err.message}`;
    }
  }

  function scrollToEndpoint(id) {
    const moduleByEndpoint = {
      'messages-send': 'messages',
      'sessions-groups': 'sessions',
    };
    switchModule(moduleByEndpoint[id] || 'messages');
    setTimeout(() => {
      document.getElementById(`ep-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }

  function switchModule(moduleId) {
    document.querySelectorAll('.module-nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.module === moduleId);
    });
    const title = document.getElementById('moduleTitle');
    const mod = manifest?.modules.find((m) => m.id === moduleId);
    if (title && mod) {
      title.textContent = mod.label;
      title.style.display = moduleId === 'quickstart' || moduleId === 'playground' ? 'none' : 'block';
    }

    const container = document.getElementById('endpointDocsContainer');
    if (moduleId === 'playground') {
      document.getElementById('playgroundSection').style.display = 'block';
      if (container) container.style.display = 'none';
      document.getElementById('quickStartSection').style.display = 'none';
    } else if (moduleId === 'quickstart') {
      document.getElementById('playgroundSection').style.display = 'none';
      if (container) container.style.display = 'none';
      document.getElementById('quickStartSection').style.display = 'block';
    } else {
      document.getElementById('playgroundSection').style.display = 'none';
      document.getElementById('quickStartSection').style.display = 'none';
      if (container) {
        container.style.display = 'block';
        renderModuleEndpoints(moduleId, container);
      }
    }
  }

  function initCredentialBar() {
    const modeSelect = document.getElementById('credModeSelect');
    const apiKeyInput = document.getElementById('apiKeyPasteInput');
    if (modeSelect) {
      modeSelect.value = getCredentialMode();
      modeSelect.addEventListener('change', () => {
        sessionStorage.setItem('devConsoleCredMode', modeSelect.value);
        if (apiKeyInput) apiKeyInput.style.display = modeSelect.value === 'api_key' ? 'block' : 'none';
      });
    }
    if (apiKeyInput) {
      apiKeyInput.value = getApiKeyPaste();
      apiKeyInput.style.display = getCredentialMode() === 'api_key' ? 'block' : 'none';
      apiKeyInput.addEventListener('input', () => {
        sessionStorage.setItem('devConsoleApiKey', apiKeyInput.value.trim());
      });
    }
  }

  function renderSidebar() {
    const nav = document.getElementById('moduleNav');
    if (!nav || !manifest) return;
    const items = manifest.modules.map((m) =>
      `<button type="button" class="module-nav-btn" data-module="${m.id}" onclick="DevConsole.switchModule('${m.id}')">${escapeHtml(m.label)}</button>`
    );
    items.push(`<button type="button" class="module-nav-btn" data-module="playground" onclick="DevConsole.switchModule('playground')">🧪 Playground</button>`);
    nav.innerHTML = items.join('');
  }

  async function init() {
    try {
      const res = await fetch('/js/api-endpoints.manifest.json');
      manifest = await res.json();
    } catch (err) {
      console.error('Failed to load API manifest', err);
      return;
    }
    renderSidebar();
    initCredentialBar();
    // Leave full reference collapsed until user picks a sidebar module
    document.getElementById('endpointDocsContainer').style.display = 'none';
    document.getElementById('quickStartSection').style.display = 'none';
    document.getElementById('playgroundSection').style.display = 'none';
    const title = document.getElementById('moduleTitle');
    if (title) {
      title.textContent = 'Select a module in the sidebar';
      title.style.display = 'block';
    }
  }

  window.DevConsole = {
    init,
    switchModule,
    tryEndpoint,
    scrollToEndpoint,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
