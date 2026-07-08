# Copy Promo Standalone

Projeto local extraído dos arquivos canônicos `CopyPromo.tsx`, `copyPromoService.ts`, `whatsappService.ts`, `server.ts` e `db.ts`.

## Como rodar

1. Instale dependências:

```bash
npm install
```

2. Inicie o servidor:

```bash
npm start
```

3. Abra no navegador:

```text
http://localhost:3000
```

## O que fica configurável pela UI

- URI e database name do MongoDB
- Credenciais Shopee
- Credenciais Amazon
- Credenciais Mercado Livre
- Credenciais AliExpress
- Número de pareamento do WhatsApp
- Partições de destino
- Grupos de origem sincronizados do WhatsApp
- Automações Copy Promo
- Teste manual do fluxo

## Persistência

- Principal: `data/local-store.json`
- Sessão WhatsApp: `data/whatsapp-session`
- Opcional: snapshot em MongoDB quando habilitado na interface

## Observação de adaptação

O app foi reduzido para um contexto local de usuário único. O fluxo central de webhook, parsing de links, troca para links afiliados, gestão de automações, grupos e logs foi preservado em torno dessa arquitetura standalone.
