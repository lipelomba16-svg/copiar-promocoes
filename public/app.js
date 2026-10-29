const state = {
  bootstrap: null
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.errorMessage || `Erro ${response.status}`);
  return data;
}

function formPayload(form) {
  const data = new FormData(form);
  return Object.fromEntries(data.entries());
}

function text(id, value) {
  document.getElementById(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const SECRET_FIELDS = ['secret', 'cookies', 'cookie', 'csrfToken', 'appSecret'];

function fillProviderForm(provider, values = {}) {
  const form = document.querySelector(`form[data-provider="${provider}"]`);
  if (!form) return;
  for (const [key, value] of Object.entries(values)) {
    // Segredos vêm mascarados do backend e o campo em branco no save
    // significa "manter a credencial salva": nunca preencher o input
    // com a máscara, senão a máscara sobrescreveria o segredo real.
    if (SECRET_FIELDS.includes(key)) continue;
    const input = form.querySelector(`[name="${key}"]`);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
  }
}

function renderProviderPreview(provider, values = {}) {
  const el = document.getElementById(`provider-status-${provider}`);
  if (!el || !values) return;
  const preview = values.secretPreview || values.appSecretPreview || values.cookiesPreview || values.cookiePreview || '';
  const cookieLength = values.cookiesLength ?? values.cookieLength ?? 0;
  const parts = [];
  if (preview) parts.push(`Salva: ${preview}`);
  if (cookieLength) parts.push(`Cookie: ${cookieLength} caracteres`);
  if (values.isActive === false) parts.push('Inativa');
  el.textContent = parts.join(' · ') || 'Nenhuma credencial salva.';
}

function renderGroups(groups = []) {
  const list = document.getElementById('groupList');
  list.innerHTML = groups.map((group) => `
    <article class="item">
      <div class="item-head">
        <div>
          <strong>${group.groupName}</strong>
          <small>${(group.groupIdentifiers || []).join(', ')}</small>
          <small>${group.useNativeLinkPreview ? 'Preview nativo' : 'Envio com foto/texto'}</small>
        </div>
        <div class="actions">
          <button data-edit-group="${group.id}">Editar</button>
          <button data-delete-group="${group.id}">Excluir</button>
        </div>
      </div>
    </article>
  `).join('');
}

function renderConfigs(configs = [], groups = []) {
  const list = document.getElementById('configList');
  list.innerHTML = configs.map((config) => {
    const target = groups.find((group) => group.id === config.targetGroupId);
    return `
      <article class="item">
        <div class="item-head">
          <div>
            <strong>${config.name}</strong>
            <small>${config.sourceGroupName || config.sourceGroupId} -> ${target?.groupName || 'Sem destino'}</small>
            <small>Webhook: ${location.origin}/api/copy-promo/webhook/${config.webhookToken}</small>
            <small>Status: ${config.lastStatus || 'idle'} | Enviadas: ${config.sentCount || 0} | Ignoradas: ${config.skippedCount || 0}${config.lastRunAt ? ` | Última: ${config.lastRunAt}` : ''}</small>
            ${config.lastError ? `<small>Último erro: ${config.lastError}</small>` : ''}
          </div>
          <div class="actions">
            <button data-edit-config="${config.id}">Editar</button>
            <button data-rotate-config="${config.id}">Novo webhook</button>
            <button data-delete-config="${config.id}">Excluir</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderLogs(logs = []) {
  const list = document.getElementById('logList');
  list.innerHTML = logs.map((log) => `
    <article class="item">
      <strong>${log.status || 'n/a'} · ${log.provider || 'unknown'}</strong>
      <small>${log.createdAt || ''}</small>
      <small>${log.sourceGroupName || ''}${log.price ? ` · ${log.price}` : ''}${log.coupon ? ` · cupom ${log.coupon}` : ''}</small>
      ${log.originalUrl ? `<small>Original: ${log.originalUrl}</small>` : ''}
      ${log.affiliateUrl ? `<small>Afiliado: ${log.affiliateUrl}</small>` : ''}
      <small>${log.messagePreview || ''}</small>
      ${log.error ? `<small>Erro: ${log.error}</small>` : ''}
    </article>
  `).join('');
}

function populateSelect(selectId, options, valueKey = 'id', labelKey = 'name') {
  const select = document.getElementById(selectId);
  const current = select.value;
  select.innerHTML = `<option value="">Selecione</option>` + options.map((item) => `<option value="${item[valueKey]}">${item[labelKey]}</option>`).join('');
  if (current) select.value = current;
}

async function refreshBootstrap() {
  const data = await api('/api/bootstrap');
  state.bootstrap = data;
  document.getElementById('mongoUri').value = data.settings.mongo.uri || '';
  document.getElementById('mongoDatabaseName').value = data.settings.mongo.databaseName || '';
  document.getElementById('mongoEnabled').checked = !!data.settings.mongo.enabled;
  text('mongoStatus', data.settings.mongo);
  fillProviderForm('shopee', data.settings.providers.shopee);
  fillProviderForm('amazon', data.settings.providers.amazon);
  fillProviderForm('mercadolivre', data.settings.providers.mercadolivre);
  fillProviderForm('aliexpress', data.settings.providers.aliexpress);
  for (const provider of ['shopee', 'amazon', 'mercadolivre', 'aliexpress']) {
    renderProviderPreview(provider, data.settings.providers[provider]);
  }
  renderGroups(data.groups);
  renderConfigs(data.copyPromoConfigs, data.groups);
  renderLogs(data.logs);
  const wa = data.whatsapp || {};
  text('waStatus', wa);
  document.getElementById('waPairing').textContent = wa.pairingCode ? `Código: ${wa.pairingCode}` : '';
  const qr = document.getElementById('waQr');
  qr.src = wa.qrCodeUrl || '';
  qr.classList.toggle('visible', !!wa.qrCodeUrl);
  populateSelect('configTarget', data.groups.map((group) => ({ id: group.id, name: group.groupName })));
  populateSelect('testConfigId', data.copyPromoConfigs.map((config) => ({ id: config.id, name: config.name })));
  const sourceOptions = (wa.groups || []).map((group) => ({ id: group.id, name: `${group.name} (${group.id})` }));
  populateSelect('configSource', sourceOptions);
  const health = await api('/api/health');
  document.getElementById('healthBadge').textContent = health.mongo.connected ? 'Mongo conectado' : 'Mongo opcional';
}

document.getElementById('refreshAll').addEventListener('click', refreshBootstrap);

document.querySelector('[data-action="test-mongo"]').addEventListener('click', async () => {
  try {
    const result = await api('/api/settings/mongo/test', {
      method: 'POST',
      body: JSON.stringify({
        uri: document.getElementById('mongoUri').value,
        databaseName: document.getElementById('mongoDatabaseName').value
      })
    });
    text('mongoStatus', result);
  } catch (error) {
    text('mongoStatus', error.message);
  }
});

document.querySelector('[data-action="save-mongo"]').addEventListener('click', async () => {
  await api('/api/settings/mongo', {
    method: 'POST',
    body: JSON.stringify({
      uri: document.getElementById('mongoUri').value,
      databaseName: document.getElementById('mongoDatabaseName').value,
      enabled: document.getElementById('mongoEnabled').checked
    })
  });
  await refreshBootstrap();
});

document.querySelector('[data-action="wa-connect"]').addEventListener('click', async () => { await api('/api/whatsapp/connect', { method: 'POST' }); await refreshBootstrap(); });
document.querySelector('[data-action="wa-pair"]').addEventListener('click', async () => { await api('/api/whatsapp/pair', { method: 'POST', body: JSON.stringify({ phoneNumber: document.getElementById('waPhone').value }) }); await refreshBootstrap(); });
document.querySelector('[data-action="wa-refresh"]').addEventListener('click', async () => { await api('/api/whatsapp/groups/refresh', { method: 'POST' }); await refreshBootstrap(); });
document.querySelector('[data-action="wa-manual-source"]').addEventListener('click', async () => {
  const jid = document.getElementById('manualSourceJid').value.trim();
  if (!jid) return;
  try {
    const result = await api('/api/whatsapp/manual-source', { method: 'POST', body: JSON.stringify({ jid }) });
    document.getElementById('manualSourceJid').value = '';
    await refreshBootstrap();
    const select = document.getElementById('configSource');
    select.value = result.entry.id;
  } catch (error) {
    text('manualSourceStatus', error.message);
  }
});

document.querySelector('[data-action="auto-search-diag"]').addEventListener('click', async () => {
  try {
    const result = await api('/api/auto-search/diagnostics');
    text('autoSearchDiagnostics', result);
  } catch (error) {
    text('autoSearchDiagnostics', error.message);
  }
});

document.querySelector('[data-action="wa-disconnect"]').addEventListener('click', async () => { await api('/api/whatsapp/disconnect', { method: 'POST' }); await refreshBootstrap(); });

document.querySelectorAll('[data-provider-test]').forEach((button) => {
  button.addEventListener('click', async () => {
    const provider = button.getAttribute('data-provider-test');
    const form = document.querySelector(`form[data-provider="${provider}"]`);
    const payload = formPayload(form);
    payload.isActive = form.querySelector('[name="isActive"]').checked;
    try {
      const result = await api(`/api/providers/${provider}/test`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      text(`provider-status-${provider}`, result);
    } catch (error) {
      text(`provider-status-${provider}`, error.message);
    }
  });
});

document.querySelectorAll('form[data-provider]').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const provider = form.getAttribute('data-provider');
    const payload = formPayload(form);
    payload.isActive = form.querySelector('[name="isActive"]').checked;
    const result = await api(`/api/providers/${provider}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    text(`provider-status-${provider}`, result);
    await refreshBootstrap();
  });
});

document.getElementById('groupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = document.getElementById('groupId').value;
  const payload = {
    id,
    groupName: document.getElementById('groupName').value,
    groupIdentifiers: document.getElementById('groupIdentifiers').value.split('\n').map((item) => item.trim()).filter(Boolean),
    useNativeLinkPreview: document.getElementById('groupNativePreview').checked,
    preserveSourceImageInNativePreview: document.getElementById('groupPreserveImage').checked
  };
  await api(id ? `/api/groups/${id}` : '/api/groups', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(payload)
  });
  document.getElementById('groupForm').reset();
  document.getElementById('groupId').value = '';
  await refreshBootstrap();
});

document.getElementById('groupReset').addEventListener('click', () => {
  document.getElementById('groupForm').reset();
  document.getElementById('groupId').value = '';
});

document.getElementById('configForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const sourceSelect = document.getElementById('configSource');
  const targetSelect = document.getElementById('configTarget');
  const selectedSourceId = sourceSelect.value;
  const sourceEntry = (state.bootstrap?.whatsapp?.groups || []).find((group) => group.id === selectedSourceId);
  const selectedSourceLabel = sourceEntry?.name || (sourceSelect.options[sourceSelect.selectedIndex]?.textContent || '').replace(/\s*\([^)]*\)\s*$/, '');
  const payload = {
    id: document.getElementById('configId').value,
    name: document.getElementById('configName').value,
    sourceGroupId: sourceSelect.value,
    sourceGroupName: selectedSourceLabel,
    targetGroupId: targetSelect.value,
    isActive: document.getElementById('configActive').checked
  };
  await api(payload.id ? `/api/copy-promo/config/${payload.id}` : '/api/copy-promo/config', {
    method: payload.id ? 'PUT' : 'POST',
    body: JSON.stringify(payload)
  });
  document.getElementById('configForm').reset();
  document.getElementById('configId').value = '';
  await refreshBootstrap();
});

document.getElementById('configReset').addEventListener('click', () => {
  document.getElementById('configForm').reset();
  document.getElementById('configId').value = '';
});

document.getElementById('testForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/copy-promo/test', {
      method: 'POST',
      body: JSON.stringify({
        configId: document.getElementById('testConfigId').value,
        text: document.getElementById('testMessage').value,
        imageUrl: document.getElementById('testImageUrl').value
      })
    });
    text('testResult', result);
    await refreshBootstrap();
  } catch (error) {
    text('testResult', error.message);
  }
});

document.addEventListener('click', async (event) => {
  const groupEdit = event.target.getAttribute('data-edit-group');
  const groupDelete = event.target.getAttribute('data-delete-group');
  const configEdit = event.target.getAttribute('data-edit-config');
  const configDelete = event.target.getAttribute('data-delete-config');
  const configRotate = event.target.getAttribute('data-rotate-config');
  if (groupEdit) {
    const group = state.bootstrap.groups.find((item) => item.id === groupEdit);
    document.getElementById('groupId').value = group.id;
    document.getElementById('groupName').value = group.groupName;
    document.getElementById('groupIdentifiers').value = (group.groupIdentifiers || []).join('\n');
    document.getElementById('groupNativePreview').checked = !!group.useNativeLinkPreview;
    document.getElementById('groupPreserveImage').checked = !!group.preserveSourceImageInNativePreview;
  }
  if (groupDelete) {
    await api(`/api/groups/${groupDelete}`, { method: 'DELETE' });
    await refreshBootstrap();
  }
  if (configEdit) {
    const config = state.bootstrap.copyPromoConfigs.find((item) => item.id === configEdit);
    document.getElementById('configId').value = config.id;
    document.getElementById('configName').value = config.name;
    document.getElementById('configSource').value = config.sourceGroupId;
    document.getElementById('configTarget').value = config.targetGroupId;
    document.getElementById('configActive').checked = !!config.isActive;
  }
  if (configDelete) {
    await api(`/api/copy-promo/config/${configDelete}`, { method: 'DELETE' });
    await refreshBootstrap();
  }
  if (configRotate) {
    await api('/api/copy-promo/rotate-webhook', {
      method: 'POST',
      body: JSON.stringify({ configId: configRotate })
    });
    await refreshBootstrap();
  }
});

refreshBootstrap();
