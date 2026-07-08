import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeStore } from './src/lib/store.js';
import { getMongoStatus, reconnectMongoFromSettings, saveMongoSettings, testMongoConnection } from './src/lib/mongoBridge.js';
import { copyPromoService } from './src/services/copyPromoService.js';
import { providerService } from './src/services/providerService.js';
import { whatsappService } from './src/services/whatsappService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3001;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (_req, res) => {
  const snapshot = await initializeStore();
  res.json({
    ok: true,
    appVersion: snapshot.version,
    mongo: getMongoStatus(),
    storageFile: snapshot.__meta?.storageFile || ''
  });
});

app.get('/api/bootstrap', async (_req, res) => {
  const state = await initializeStore();
  const safeSettings = {
    ...state.settings,
    security: { encryptionKey: 'stored-locally-hidden' }
  };
  res.json({
    settings: safeSettings,
    groups: state.groups,
    copyPromoConfigs: state.copyPromoConfigs,
    logs: state.logs.slice(-100).reverse(),
    whatsapp: await whatsappService.getStatus(),
    sourceAnalysis: state.sourceAnalysis
  });
});

app.post('/api/settings/mongo/test', async (req, res) => {
  const result = await testMongoConnection(req.body || {});
  res.status(result.ok ? 200 : 422).json(result);
});

app.post('/api/settings/mongo', async (req, res) => {
  try {
    const result = await saveMongoSettings(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const settings = await copyPromoService.saveSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.get('/api/providers/:provider', async (req, res) => {
  res.json(await providerService.getConfig(req.params.provider));
});

app.post('/api/providers/:provider/test', async (req, res) => {
  const result = await providerService.testProvider(req.params.provider, req.body || {});
  res.status(result.valid ? 200 : 422).json(result);
});

app.post('/api/providers/:provider', async (req, res) => {
  try {
    const config = await providerService.saveProvider(req.params.provider, req.body || {});
    res.json({ ok: true, config });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.get('/api/whatsapp/status', async (_req, res) => {
  res.json(await whatsappService.getStatus());
});

app.post('/api/whatsapp/connect', async (_req, res) => {
  try {
    await whatsappService.connect();
    res.json({ ok: true, status: await whatsappService.getStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.post('/api/whatsapp/pair', async (req, res) => {
  try {
    await whatsappService.connect(String(req.body?.phoneNumber || '').trim());
    res.json({ ok: true, status: await whatsappService.getStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.post('/api/whatsapp/disconnect', async (_req, res) => {
  try {
    await whatsappService.disconnect();
    res.json({ ok: true, status: await whatsappService.getStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.post('/api/whatsapp/groups/refresh', async (_req, res) => {
  try {
    const groups = await whatsappService.refreshGroups();
    res.json({ ok: true, groups });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.get('/api/groups', async (_req, res) => {
  res.json(await copyPromoService.listGroups());
});

app.post('/api/groups', async (req, res) => {
  try {
    res.status(201).json(await copyPromoService.saveGroup(req.body || {}));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || String(error) });
  }
});

app.put('/api/groups/:id', async (req, res) => {
  try {
    res.json(await copyPromoService.saveGroup({ ...(req.body || {}), id: req.params.id }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || String(error) });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  res.json(await copyPromoService.deleteGroup(req.params.id));
});

app.get('/api/copy-promo/configs', async (_req, res) => {
  res.json(await copyPromoService.listConfigs());
});

app.post('/api/copy-promo/config', async (req, res) => {
  try {
    res.json(await copyPromoService.saveConfig(req.body || {}));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || String(error) });
  }
});

app.put('/api/copy-promo/config/:id', async (req, res) => {
  try {
    res.json(await copyPromoService.saveConfig({ ...(req.body || {}), id: req.params.id }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || String(error) });
  }
});

app.delete('/api/copy-promo/config/:id', async (req, res) => {
  res.json(await copyPromoService.deleteConfig(req.params.id));
});

app.post('/api/copy-promo/rotate-webhook', async (req, res) => {
  try {
    res.json(await copyPromoService.rotateWebhook(String(req.body?.configId || '')));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || String(error) });
  }
});

app.get('/api/copy-promo/logs', async (req, res) => {
  res.json(await copyPromoService.getLogs(Number(req.query.limit || 100)));
});

app.post('/api/copy-promo/test', async (req, res) => {
  try {
    res.json(await copyPromoService.testConfig(req.body || {}));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.post('/api/copy-promo/webhook/:token', async (req, res) => {
  try {
    res.json(await copyPromoService.handleWebhook(String(req.params.token || ''), req.body || {}));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

await initializeStore();
await reconnectMongoFromSettings();
await whatsappService.bootstrap();

app.listen(port, () => {
  console.log(`Copy Promo Standalone em http://localhost:${port}`);
});
