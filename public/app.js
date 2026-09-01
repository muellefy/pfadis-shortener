const KEY_STORAGE = 'pfadis_api_key';

const els = {
  authGate: document.getElementById('authGate'),
  googleSignIn: document.getElementById('googleSignIn'),
  keyForm: document.getElementById('keyForm'),
  keyInput: document.getElementById('keyInput'),
  keyError: document.getElementById('keyError'),
  sessionBar: document.getElementById('sessionBar'),
  sessionEmail: document.getElementById('sessionEmail'),
  signOutBtn: document.getElementById('signOutBtn'),
  createForm: document.getElementById('createForm'),
  urlInput: document.getElementById('urlInput'),
  codeInput: document.getElementById('codeInput'),
  createError: document.getElementById('createError'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  template: document.getElementById('itemTemplate'),
};

function getKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

function authHeaders() {
  const key = getKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function checkSession() {
  const res = await fetch('/api/session');
  const session = await res.json();

  if (session.authenticated) {
    els.authGate.classList.add('hidden');
    if (session.email) {
      els.sessionBar.classList.remove('hidden');
      els.sessionEmail.textContent = `Signed in as ${session.email}`;
    }
    await loadLinks();
    return;
  }

  // Not authenticated: show Google button, key form, or both, matching what's configured server-side.
  els.authGate.classList.remove('hidden');
  els.googleSignIn.classList.toggle('hidden', !session.googleEnabled);
  els.keyForm.classList.toggle('hidden', !session.apiKeyEnabled);
}

els.signOutBtn.addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.reload();
});

els.keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  localStorage.setItem(KEY_STORAGE, els.keyInput.value.trim());
  const res = await fetch('/api/links', { headers: authHeaders() });
  if (res.status === 401) {
    els.keyError.textContent = 'That key was not accepted.';
    els.keyError.classList.remove('hidden');
    return;
  }
  els.keyInput.value = '';
  await checkSession();
});

els.createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.createError.classList.add('hidden');

  const url = els.urlInput.value.trim();
  const code = els.codeInput.value.trim();

  try {
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ url, code: code || undefined }),
    });

    if (res.status === 401) return checkSession();

    const data = await res.json();
    if (!res.ok) {
      els.createError.textContent = data.error || 'Something went wrong.';
      els.createError.classList.remove('hidden');
      return;
    }

    els.createForm.reset();
    await loadLinks();
  } catch (err) {
    els.createError.textContent = 'Could not reach the server.';
    els.createError.classList.remove('hidden');
  }
});

async function loadLinks() {
  const res = await fetch('/api/links', { headers: authHeaders() });
  if (res.status === 401) {
    await checkSession();
    return false;
  }
  const rows = await res.json();
  render(rows);
  return true;
}

function render(rows) {
  els.list.innerHTML = '';
  els.count.textContent = rows.length ? `${rows.length} link${rows.length === 1 ? '' : 's'}` : '';
  els.empty.classList.toggle('hidden', rows.length > 0);

  for (const row of rows) {
    const node = els.template.content.cloneNode(true);
    const li = node.querySelector('.card');
    const qr = node.querySelector('.card__qr');
    const short = node.querySelector('.card__short');
    const dest = node.querySelector('.card__dest');
    const clicks = node.querySelector('.card__clicks');
    const date = node.querySelector('.card__date');

    qr.src = `/api/links/${row.code}/qr?format=png`;
    short.href = row.shortUrl;
    short.textContent = row.shortUrl.replace(/^https?:\/\//, '');
    dest.textContent = row.url;
    clicks.textContent = `${row.clicks} click${row.clicks === 1 ? '' : 's'}`;
    date.textContent = new Date(row.created_at + 'Z').toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
    });

    li.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(btn.dataset.action, row));
    });

    els.list.appendChild(node);
  }
}

async function handleAction(action, row) {
  if (action === 'copy') {
    await navigator.clipboard.writeText(row.shortUrl);
    return;
  }
  if (action === 'png' || action === 'svg') {
    const res = await fetch(`/api/links/${row.code}/qr?format=${action}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${row.code}-qr.${action}`;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  if (action === 'delete') {
    if (!confirm(`Delete ${row.shortUrl}? This can't be undone.`)) return;
    const res = await fetch(`/api/links/${row.code}`, { method: 'DELETE', headers: authHeaders() });
    if (res.status === 401) return checkSession();
    await loadLinks();
  }
}

checkSession();
