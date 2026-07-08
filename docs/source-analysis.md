# Copy Promo Standalone Analysis

Arquivos canônicos estudados:

- `CopyPromo.tsx`: definiu a UX central de automações, grupos de origem/destino, webhook, logs e preview do WhatsApp.
- `copyPromoService.ts`: definiu o fluxo principal de parsing da mensagem, extração de URLs, troca por links afiliados, logs, counters e webhook processing.
- `whatsappService.ts`: definiu a necessidade de sessão WhatsApp persistente, sincronização de grupos e envio para múltiplos destinos.
- `server.ts`: definiu as rotas mínimas realmente necessárias para o standalone.
- `db.ts`: definiu os modelos relevantes que foram reduzidos para o standalone: configurações, grupos, credenciais por provider e logs.

Adaptações feitas:

- Autenticação multiusuário foi removida; o standalone trabalha em modo local com um único contexto.
- Persistência principal usa `data/local-store.json`, com espelhamento opcional em MongoDB via snapshot configurado pela UI.
- Credenciais que antes passavam por `process.env` e modelos do app completo foram levadas para a interface.
- O envio WhatsApp usa Baileys com sessão local em `data/whatsapp-session`.
- O fluxo Mercado Livre foi adaptado para aceitar, na UI, a `createLinkUrl` necessária para gerar links afiliados de produto, além da URL de lista/cupom.
