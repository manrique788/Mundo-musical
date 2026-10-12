# Mundo Musical — projeto inicial

Site responsivo para catálogo e reprodução de músicas autorizadas. Inclui busca, filtro por gênero e player fixo. Funciona como site estático.

## O que já está pronto
- Interface adaptada para celular e computador
- Busca por título, artista e gênero
- Filtros por gênero
- Player com play/pausa, faixa anterior/próxima, volume e barra de progresso
- Catálogo carregado do arquivo `songs.json`

## Importante sobre Cloudflare R2
O site não recebe nem envia músicas para o R2 automaticamente. Primeiro é necessário criar um bucket, enviar os arquivos de áudio e configurar acesso público ou um domínio personalizado. Nunca coloque chaves secretas da Cloudflare no `app.js`, `index.html` ou em qualquer arquivo público.

Para reprodução pelo navegador, cada `audioUrl` precisa ser uma URL HTTPS acessível publicamente e que entregue o arquivo de áudio diretamente, com suporte adequado a requisições de mídia. Teste com 2 ou 3 arquivos antes de migrar milhares.

## Formato de songs.json
Substitua o conteúdo `[]` por uma lista como esta, usando URLs reais dos seus próprios arquivos:
```json
[
  {
    "title": "Nome da música",
    "artist": "Artista",
    "genre": "Gênero",
    "audioUrl": "https://pub-ebe4b2f7bdd748d795783e0144838b16.r2.dev/nome-do-arquivo.mp3"
  }
]

```
Não use links de exemplo como se fossem faixas reais. Não publique música sem os direitos e licenças necessários.

## Publicar pelo celular
1. Extraia o ZIP com o gerenciador de arquivos do Android.
2. No GitHub, crie um repositório público chamado `mundo-musical`.
3. Envie os cinco arquivos da pasta para o repositório: `index.html`, `style.css`, `app.js`, `songs.json`, `README.md`.
4. Na Vercel, importe o repositório e publique como projeto estático. Não é necessário comando de build.
5. Depois de testar o site, conectaremos as URLs públicas do R2 ao catálogo.

## Custos
Dez mil músicas com 50–100 GB excedem a franquia gratuita de armazenamento do R2. O custo depende do armazenamento, das operações e dos serviços adicionais. Verifique os preços oficiais antes de migrar a biblioteca.
