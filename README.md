# MUSIC VIP

O MUSIC é um PWA de música com player, catálogo servido pelo Worker Cloudflare e login por e-mail.

## Acesso premium

O acesso exige conta desde a abertura: na primeira utilização, crie uma conta; nas visitas seguintes, entre com sua conta. Após autenticar, o app apresenta o plano MUSIC VIP por **R$ 15 em pagamento único, com acesso vitalício**. O checkout atual do Mercado Pago continua disponível para outras formas, e o botão **Pagar com Pix · QR Code** cria uma cobrança Pix dinâmica vinculada ao pedido. O acesso só é liberado depois da confirmação do pagamento pelo servidor.

O streaming protegido, o Checkout Pro, a cobrança Pix e a verificação dos Webhooks são implementados em `worker/worker.mjs`. As migrações aditivas do D1 ficam em `worker/migrations/` (`0001_lifetime_access.sql`, `0002_payment_reconciliation.sql` e `0003_pix_checkout.sql`). A opção Pix usa a API Payments do Mercado Pago e exige uma chave Pix cadastrada na conta recebedora. Os segredos do Mercado Pago devem ser configurados diretamente na seção **Workers & Pages → mundo-musical-api → Settings → Variables and Secrets** no painel Cloudflare; não salve tokens no repositório nem os envie em mensagens. Nomes esperados: `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` e `MEDIA_SIGNING_SECRET`.

Configure na aplicação Mercado Pago o Webhook de pagamento para `https://mundo-musical-api.manriquewb1234.workers.dev/payments/webhook` e selecione o evento de pagamentos (`payment`). Use a chave Webhook correspondente em `MERCADOPAGO_WEBHOOK_SECRET`. O endpoint Pix recebe a notificação e reconcilia o pagamento com o Mercado Pago antes de liberar o acesso; o checkout permanece indisponível enquanto as duas credenciais necessárias não estiverem configuradas.

O bucket R2 `musicaspasta` deve manter `r2.dev` habilitado até a validação de streaming protegido; depois disso, desative o domínio público gerenciado do bucket para impedir acesso direto aos objetos.

## Instalar como aplicativo no celular

O MUSIC é um PWA instalável, sem publicação na Play Store ou App Store.

### Android (Chrome)

1. Abra o site publicado no Chrome.
2. Toque em **＋ Instalar** no cabeçalho ou no menu ⋮ do navegador.
3. Confirme em **Instalar**.

### iPhone (Safari)

1. Abra o site no Safari.
2. Toque em **Compartilhar**.
3. Escolha **Adicionar à Tela de Início** e confirme.

A interface do PWA funciona em cache, mas a biblioteca e os áudios exigem conexão para validar a sessão, o entitlement e o ticket de streaming no Worker. O app limpa cópias antigas de áudio offline ao atualizar. Downloads ZIP manuais, quando disponíveis, exigem acesso vitalício ativo e streaming autorizado pelo Worker.
