import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle, Copy, Loader2, MessageSquare, Pencil, Plus,
  RefreshCw, Save, Search, Shuffle, Trash2, X, XCircle
} from 'lucide-react';

type RealGroup = { id: string; name: string; type?: 'group' | 'community' | 'newsletter' };

const emptyForm = {
  name: 'Copiar Promo',
  isActive: false,
  sourceGroupId: '',
  sourceGroupName: '',
  targetGroupId: ''
};

function statusColor(status = '') {
  if (status === 'success') return 'text-emerald-300';
  if (status === 'skipped') return 'text-amber-300';
  if (status === 'error') return 'text-red-300';
  return 'text-gray-400';
}

export default function CopyPromo({ user }: { user: any }) {
  const [configs, setConfigs] = useState<any[]>([]);
  const [form, setForm] = useState<any>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [groups, setGroups] = useState<any[]>([]);
  const [realGroups, setRealGroups] = useState<RealGroup[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [sourceSearch, setSourceSearch] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [previewBridge, setPreviewBridge] = useState<any>({ status: 'disconnected', qrCodeUrl: null, logs: [] });
  const [previewBridgeBusy, setPreviewBridgeBusy] = useState(false);
  const [previewPhoneNumber, setPreviewPhoneNumber] = useState('');

  const showMsg = (type: 'success' | 'error', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4500);
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cfgs, partitions, history] = await Promise.all([
        fetch('/api/copy-promo/configs', { credentials: 'include' }).then(r => r.json()),
        fetch('/api/groups', { credentials: 'include' }).then(r => r.json()),
        fetch('/api/copy-promo/logs', { credentials: 'include' }).then(r => r.json())
      ]);
      const list = Array.isArray(cfgs) ? cfgs : [];
      setConfigs(list);
      setGroups(Array.isArray(partitions) ? partitions : []);
      setLogs(Array.isArray(history) ? history : []);
    } catch (error: any) {
      showMsg('error', error.message || 'Erro ao carregar Copiar Promo.');
    } finally {
      setLoading(false);
    }
  };

  const loadWhatsAppGroups = async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        await fetch('/api/whatsapp/groups/refresh', { method: 'POST', credentials: 'include' });
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      const res = await fetch('/api/whatsapp/status?t=' + Date.now(), { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRealGroups(data.groups || []);
      }
    } catch {}
  };

  const loadPreviewBridgeStatus = async () => {
    try {
      const res = await fetch('/api/whatsapp-webjs-v2/status?t=' + Date.now(), { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setPreviewBridge(data || { status: 'disconnected', qrCodeUrl: null, logs: [] });
      }
    } catch {}
  };


  const connectPreviewBridge = async (phoneNumber = '') => {
    setPreviewBridgeBusy(true);
    try {
      const res = await fetch('/api/whatsapp-webjs-v2/connect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Erro ao iniciar o modo preview.');
      showMsg('success', 'Modo preview iniciado. Se houver QR, ele aparecerá abaixo.');
      await loadPreviewBridgeStatus();
    } catch (error: any) {
      showMsg('error', error.message || 'Erro ao iniciar o modo preview.');
    } finally {
      setPreviewBridgeBusy(false);
    }
  };

  const disconnectPreviewBridge = async () => {
    setPreviewBridgeBusy(true);
    try {
      const res = await fetch('/api/whatsapp-webjs-v2/disconnect', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Erro ao desconectar o modo preview.');
      showMsg('success', 'Modo preview desconectado.');
      await loadPreviewBridgeStatus();
    } catch (error: any) {
      showMsg('error', error.message || 'Erro ao desconectar o modo preview.');
    } finally {
      setPreviewBridgeBusy(false);
    }
  };

  useEffect(() => {
    loadAll();
    loadWhatsAppGroups(true);
    loadPreviewBridgeStatus();
    const groupsInt = setInterval(loadWhatsAppGroups, 8000);
    const previewInt = setInterval(loadPreviewBridgeStatus, 2500);
    return () => {
      clearInterval(groupsInt);
      clearInterval(previewInt);
    };
  }, []);

  const filteredSourceGroups = useMemo(() => {
    const term = sourceSearch.toLowerCase();
    return realGroups.filter(g => g.name.toLowerCase().includes(term) || g.id.toLowerCase().includes(term));
  }, [realGroups, sourceSearch]);

  const filteredTargetGroups = useMemo(() => {
    const term = targetSearch.toLowerCase();
    return groups.filter(g => g.isActive && String(g.groupName || '').toLowerCase().includes(term));
  }, [groups, targetSearch]);

  const selectedSource = realGroups.find(g => g.id === form.sourceGroupId);

  const openNew = () => {
    setEditingId(null);
    setForm({ ...emptyForm, name: `Copiar Promo ${configs.length + 1}` });
    setSourceSearch('');
    setTargetSearch('');
    setShowForm(true);
  };

  const openEdit = (cfg: any) => {
    setEditingId(cfg._id);
    setForm({
      name: cfg.name || 'Copiar Promo',
      isActive: !!cfg.isActive,
      sourceGroupId: cfg.sourceGroupId || '',
      sourceGroupName: cfg.sourceGroupName || '',
      targetGroupId: cfg.targetGroupId?._id || cfg.targetGroupId || ''
    });
    setSourceSearch('');
    setTargetSearch('');
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const save = async () => {
    if (!form.name.trim()) return showMsg('error', 'Dê um nome para a automação.');
    if (!form.sourceGroupId) return showMsg('error', 'Selecione o grupo que sera copiado.');
    if (!form.targetGroupId) return showMsg('error', 'Selecione a particao de destino.');
    setSaving(true);
    try {
      const res = await fetch(editingId ? `/api/copy-promo/config/${editingId}` : '/api/copy-promo/config', {
        method: editingId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          sourceGroupName: selectedSource?.name || form.sourceGroupName
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar.');
      showMsg('success', editingId ? 'Automação atualizada.' : 'Automação criada.');
      closeForm();
      loadAll();
    } catch (error: any) {
      showMsg('error', error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (cfg: any) => {
    const res = await fetch(`/api/copy-promo/config/${cfg._id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: cfg.name,
        sourceGroupId: cfg.sourceGroupId,
        sourceGroupName: cfg.sourceGroupName,
        targetGroupId: cfg.targetGroupId?._id || cfg.targetGroupId,
        isActive: !cfg.isActive
      })
    });
    if (!res.ok) {
      const data = await res.json();
      showMsg('error', data.error || 'Erro ao alternar status.');
    }
    loadAll();
  };

  const removeConfig = async (cfg: any) => {
    if (!confirm(`Remover a automação "${cfg.name || 'Copiar Promo'}"?`)) return;
    await fetch(`/api/copy-promo/config/${cfg._id}`, { method: 'DELETE', credentials: 'include' });
    loadAll();
  };

  const rotateWebhook = async (cfg: any) => {
    if (!confirm('Renovar webhook? O link antigo vai parar de funcionar.')) return;
    const res = await fetch('/api/copy-promo/rotate-webhook', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId: cfg._id })
    });
    const data = await res.json();
    if (res.ok) {
      showMsg('success', 'Webhook renovado.');
      loadAll();
    } else {
      showMsg('error', data.error || 'Erro ao renovar webhook.');
    }
  };

  const copyWebhook = async (cfg: any) => {
    const url = `${window.location.origin}${cfg.webhookPath}`;
    await navigator.clipboard.writeText(url);
    showMsg('success', 'URL do webhook copiada.');
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Carregando Copiar Promo...</div>;
  }

  const totals = configs.reduce((acc, cfg) => {
    acc.copied += Number(cfg.copiedCount || 0);
    acc.sent += Number(cfg.sentCount || 0);
    acc.skipped += Number(cfg.skippedCount || 0);
    return acc;
  }, { copied: 0, sent: 0, skipped: 0 });

  return (
    <div className="space-y-6 max-w-full overflow-hidden">
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 min-w-0">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 rounded-2xl bg-fuchsia-500/20 flex items-center justify-center text-fuchsia-300">
            <Shuffle className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-white">Copiar Promo</h2>
            <p className="text-sm text-gray-400">Crie automações para copiar promoções de grupos e reenviar para partições.</p>
          </div>
        </div>
        <button onClick={openNew} className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold flex items-center gap-2 self-start xl:self-auto whitespace-nowrap">
          <Plus className="w-4 h-4" /> Nova Automação
        </button>
      </div>

      {msg && (
        <div className={`p-3 rounded-xl text-sm border ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {msg.text}
        </div>
      )}

      {showForm && (
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">{editingId ? 'Editar automação' : 'Nova automação'}</h3>
            <button onClick={closeForm} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400"><X className="w-4 h-4" /></button>
          </div>

          <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-6">
            <div className="space-y-5">
              <section className="space-y-2">
                <label className="text-xs font-bold text-gray-500">Nome da automação</label>
                <input value={form.name} onChange={e => setForm((f: any) => ({ ...f, name: e.target.value }))} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-purple-500/50" />
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-gray-500">Grupo que sera copiado</label>
                  <button onClick={() => loadWhatsAppGroups(true)} className="text-[10px] text-purple-300 flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Atualizar</button>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                <input value={sourceSearch} onChange={e => setSourceSearch(e.target.value)} placeholder="Pesquisar grupos, comunidades ou canais..." className="w-full bg-black/40 border border-white/5 rounded-xl py-2 pl-9 pr-4 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500/50" />
                </div>
                <div className="bg-black/40 border border-white/10 rounded-2xl p-4 max-h-[220px] overflow-y-auto custom-scrollbar space-y-2">
                  {filteredSourceGroups.length === 0 && <div className="text-gray-600 text-xs text-center py-4">Conecte o WhatsApp ou sincronize os grupos.</div>}
                  {filteredSourceGroups.map(g => {
                    const selected = form.sourceGroupId === g.id;
                    return (
                      <div key={g.id} onClick={() => setForm((f: any) => ({ ...f, sourceGroupId: selected ? '' : g.id, sourceGroupName: selected ? '' : g.name }))}
                        className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${selected ? 'bg-purple-500/20 border-purple-500/40 text-purple-300' : 'bg-white/5 border-white/5 text-gray-400 hover:bg-white/10'}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <MessageSquare className="w-4 h-4 shrink-0 text-emerald-400" />
                          <span className="text-xs font-medium truncate">{g.name}</span>
                        </div>
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${selected ? 'bg-purple-500 border-purple-500' : 'border-white/20'}`}>
                          {selected && <CheckCircle className="w-3 h-3 text-black" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            <div className="space-y-5">
              <section className="space-y-3">
                <label className="text-xs font-bold text-gray-500">Particao de destino</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                  <input value={targetSearch} onChange={e => setTargetSearch(e.target.value)} placeholder="Pesquisar particoes..." className="w-full bg-black/40 border border-white/5 rounded-xl py-2 pl-9 pr-4 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-purple-500/50" />
                </div>
                <div className="bg-black/40 border border-white/10 rounded-2xl p-4 max-h-[220px] overflow-y-auto custom-scrollbar space-y-2">
                  {filteredTargetGroups.length === 0 && <div className="text-gray-600 text-xs text-center py-4">Nenhuma particao ativa encontrada.</div>}
                  {filteredTargetGroups.map(g => {
                    const selected = form.targetGroupId === g._id;
                    return (
                      <div key={g._id} onClick={() => setForm((f: any) => ({ ...f, targetGroupId: selected ? '' : g._id }))}
                        className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${selected ? 'bg-purple-500/20 border-purple-500/40 text-purple-300' : 'bg-white/5 border-white/5 text-gray-400 hover:bg-white/10'}`}>
                        <div className="min-w-0">
                          <span className="block text-xs font-medium truncate">{g.groupName}</span>
                          {g.nicheId?.name && <span className="block text-[10px] text-gray-600 truncate">Nicho: {g.nicheId.name}</span>}
                          <span className="block text-[10px] text-gray-600 truncate">{g.useNativeLinkPreview ? (g.preserveSourceImageInNativePreview ? 'Preview nativo · imagem original' : 'Preview nativo') : 'Envio com foto'}</span>
                        </div>
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${selected ? 'bg-purple-500 border-purple-500' : 'border-white/20'}`}>
                          {selected && <CheckCircle className="w-3 h-3 text-black" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="bg-black/30 border border-white/10 rounded-2xl p-4 text-[11px] text-gray-500 leading-relaxed">
                Os links de Mercado Livre, Shopee, Amazon e AliExpress usam as credenciais salvas na aba Credenciais de cada usuario.
              </section>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-white/10 pt-4">
            <button onClick={() => setForm((f: any) => ({ ...f, isActive: !f.isActive }))} className={`px-3 py-2 rounded-xl text-xs font-bold border ${form.isActive ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-white/5 border-white/10 text-gray-400'}`}>
              {form.isActive ? 'Ativa' : 'Inativa'}
            </button>
            <button onClick={save} disabled={saving} className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold flex items-center gap-2 disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {editingId ? 'Salvar alterações' : 'Criar automação'}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 min-w-0">
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 min-w-0"><div className="text-[10px] text-gray-500 font-bold">AUTOMACOES</div><div className="text-2xl text-white font-bold">{configs.length}</div></div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 min-w-0"><div className="text-[10px] text-gray-500 font-bold">COPIADAS</div><div className="text-2xl text-white font-bold">{totals.copied}</div></div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 min-w-0"><div className="text-[10px] text-gray-500 font-bold">ENVIADAS</div><div className="text-2xl text-emerald-300 font-bold">{totals.sent}</div></div>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 min-w-0"><div className="text-[10px] text-gray-500 font-bold">IGNORADAS</div><div className="text-2xl text-amber-300 font-bold">{totals.skipped}</div></div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-w-0">
        {configs.map(cfg => {
          const targetName = cfg.targetGroupId?.groupName || 'Sem particao';
          return (
            <div key={cfg._id} className="bg-white/5 border border-white/10 rounded-3xl p-5 space-y-4 min-w-0 overflow-hidden">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-white font-bold truncate">{cfg.name || 'Copiar Promo'}</div>
                  <div className="text-xs text-gray-500 truncate">{cfg.sourceGroupName || cfg.sourceGroupId || 'Origem nao definida'} → {targetName}</div>
                  <div className="text-[10px] text-gray-600">{cfg.targetGroupId?.useNativeLinkPreview ? (cfg.targetGroupId?.preserveSourceImageInNativePreview ? 'Preview nativo · imagem original' : 'Preview nativo') : 'Envio com foto'}</div>
                </div>
                <button onClick={() => toggleActive(cfg)} className={`px-3 py-1.5 rounded-xl text-[11px] font-bold border ${cfg.isActive ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-white/5 border-white/10 text-gray-400'}`}>
                  {cfg.isActive ? 'Ativa' : 'Inativa'}
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-black/30 rounded-xl p-2"><div className="text-[10px] text-gray-500">copiadas</div><div className="text-white font-bold">{cfg.copiedCount || 0}</div></div>
                <div className="bg-black/30 rounded-xl p-2"><div className="text-[10px] text-gray-500">enviadas</div><div className="text-emerald-300 font-bold">{cfg.sentCount || 0}</div></div>
                <div className="bg-black/30 rounded-xl p-2"><div className="text-[10px] text-gray-500">status</div><div className={`font-bold text-xs ${statusColor(cfg.lastStatus)}`}>{cfg.lastStatus || 'idle'}</div></div>
              </div>

              <div className="bg-black/30 border border-white/5 rounded-xl p-2 flex gap-2">
                <input readOnly value={`${window.location.origin}${cfg.webhookPath}`} className="flex-1 bg-transparent text-[11px] text-gray-400 outline-none min-w-0" />
                <button onClick={() => copyWebhook(cfg)} className="p-2 rounded-lg bg-white/10 hover:bg-white/15 text-white"><Copy className="w-3.5 h-3.5" /></button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <button onClick={() => openEdit(cfg)} className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-bold flex items-center gap-1.5"><Pencil className="w-3.5 h-3.5" /> Editar</button>
                <button onClick={() => rotateWebhook(cfg)} className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-gray-300 text-xs font-bold flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> Webhook</button>
                <button onClick={() => removeConfig(cfg)} className="px-3 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-bold flex items-center gap-1.5"><Trash2 className="w-3.5 h-3.5" /> Remover</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white/5 border border-white/10 rounded-3xl p-6 min-w-0 overflow-hidden">
          <h3 className="text-sm font-bold text-white mb-4">Ultimas promocoes copiadas</h3>
          <div className="space-y-2 max-h-[360px] overflow-y-auto custom-scrollbar">
            {logs.length === 0 && <div className="text-gray-600 text-sm">Nenhuma promocao copiada ainda.</div>}
            {logs.map(log => (
              <div key={log._id} className="flex items-start justify-between gap-4 bg-black/30 border border-white/5 rounded-xl p-3 min-w-0 overflow-hidden">
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="text-sm text-white font-semibold truncate">{log.productName || log.originalUrl || 'Promocao'}</div>
                  <div className="text-[11px] leading-4 text-gray-500 break-all whitespace-normal max-h-8 overflow-hidden pr-2">{log.provider} · {log.status} · {log.error || log.price || ''}</div>
                </div>
                <div className={`shrink-0 ${log.status === 'sent' ? 'text-emerald-300' : log.status === 'skipped' ? 'text-amber-300' : 'text-red-300'}`}> 
                  {log.status === 'sent' ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                </div>
              </div>
            ))}
          </div>
      </div>
    </div>
  );
}
