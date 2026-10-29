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

## Testes

```bash
npm install
npm test
```

Os testes (`tests/`) cobrem as regras puras (provider, legenda,
AutoSearch), a criptografia/máscara de credenciais e a integração
(processamento, webhook em lote, SiteStripe, meli.la, listener e
dedupe) com rede stubada — nenhum provedor real é chamado nos testes.

## Regras da especificação aplicadas neste app

- **Escuta ao vivo:** ao conectar o WhatsApp, o app escuta
  `messages.upsert` e processa mensagens de `@g.us`/`@newsletter`,
  ignorando as próprias (`fromMe`). Antes, só o webhook funcionava.
- **Canais:** descoberta best-effort (`newsletterSubscribed()` e query
  `w:mex newsletter_subscribed`), canais detectados são preservados
  no refresh, e há cadastro manual de origem por JID
  (`POST /api/whatsapp/manual-source`).
- **Legenda preservada:** só URLs são trocadas/removidas e linhas de
  assinatura/divulgação descartadas; espaços, emojis, quebras,
  `*negrito*`, preço e cupom ficam intactos. Todos os links
  permitidos são convertidos individualmente.
- **Falha de conversão = não enviar:** qualquer falha gera log
  `failed` com provider/link/erro e a mensagem não é enviada
  (nunca link comum). Amazon só envia shortlink real do SiteStripe;
  Mercado Livre resolve `meli.la` antes de `createLink`; AliExpress
  extrai `promotion_link` de várias formas de resposta; Shopee usa
  `generateShortLink` com fallback de busca já existente.
- **Credenciais criptografadas e mascaradas:** segredos são
  criptografados (AES-256-CBC, chave em `settings.security`) e o
  frontend só recebe máscara. Campo em branco no save mantém a
  credencial salva.
- **Edição de automação não zera contadores nem troca o webhook:**
  `saveConfig` faz merge e ignora `webhookToken`/contadores do
  cliente.
- **Busca Automática / Compare:** registro único com os 4 provedores,
  rodízio Shopee → Mercado Livre → AliExpress → Amazon e diagnóstico
  em `GET /api/auto-search/diagnostics`. O Compare completo do app
  original (legacy `server.ts`, com dependências ausentes neste
  repositório) não foi alterado — o registro aqui serve a este app.
- **Nota de cupom Shopee:** mensagem Shopee sem "cupom" ganha
  `cupom: Aplicável na hora da compra!` (única adição de texto;
  desligável por automação via `addShopeeCouponNote: false`).
