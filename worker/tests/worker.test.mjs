import test from "node:test";
import assert from "node:assert/strict";
import musicWorker, {
  parseByteRange,
  streamR2,
  verifyWebhookSignature
} from "../worker.mjs";

const encoder = new TextEncoder();
const MEDIA_SECRET = "unit-test-media-signing-secret";
const testObjects = [
  { key: "Funk/01 - Faixa A.mp3" },
  { key: "Funk/02 - Faixa B.mp3" },
  { key: "Pagode/01 - Faixa C.mp3" }
];

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function mediaTicket(secret, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return payload + "." + Buffer.from(new Uint8Array(signature)).toString("base64url");
}

function fakeR2Object(bytes, fullSize = bytes.length) {
  return {
    size: fullSize,
    etag: "test-etag",
    httpEtag: '"test-etag"',
    uploaded: new Date("2026-01-01T00:00:00.000Z"),
    httpMetadata: { contentType: "audio/mpeg" },
    body: new Response(bytes).body,
    writeHttpMetadata(headers) {
      headers.set("Content-Type", "audio/mpeg");
      headers.set("Cache-Control", "public, max-age=31536000");
    }
  };
}

function testEnvironment(objects = testObjects) {
  const audio = new Map([
    ["Funk/01 - Faixa A.mp3", encoder.encode("AUDIO A")],
    ["Funk/02 - Faixa B.mp3", encoder.encode("AUDIO B")],
    ["Pagode/01 - Faixa C.mp3", encoder.encode("AUDIO C")]
  ]);
  let headCalls = 0;
  let listCalls = 0;
  const bucket = {
    async list(options = {}) {
      listCalls++;
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = Number(options.limit) || 1000;
      const page = objects.slice(start, start + limit);
      const next = start + page.length;
      const truncated = next < objects.length;
      return { objects: page, truncated, cursor: truncated ? String(next) : undefined };
    },
    async head(key) { headCalls++; return audio.has(key) ? fakeR2Object(audio.get(key)) : null; },
    async get(key, options) {
      const bytes = audio.get(key);
      if (!bytes) return null;
      if (options && options.range) {
        const { offset, length } = options.range;
        return fakeR2Object(bytes.slice(offset, offset + length), bytes.length);
      }
      return fakeR2Object(bytes);
    },
    get headCallCount() { return headCalls; },
    get listCallCount() { return listCalls; }
  };
  return {
    DB: {},
    MEDIA_SIGNING_SECRET: MEDIA_SECRET,
    MUSIC_BUCKET: bucket
  };
}

function authenticatedEnvironment({ entitled = false, sessionActive = true, objects = testObjects } = {}) {
  const env = testEnvironment(objects);
  const user = { id: "user-1", email: "test@example.com", session_id: "session-1", expires_at: "2099-01-01T00:00:00.000Z" };
  const state = { entitled, sessionActive };
  let streamAuthorizationQueries = 0;
  env.DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM sessions") && sql.includes("LEFT JOIN user_entitlements")) {
                streamAuthorizationQueries++;
                return state.sessionActive
                  ? { session_id: user.session_id, entitlement_id: state.entitled ? "entitlement-1" : null }
                  : null;
              }
              if (sql.includes("JOIN users")) return user;
              if (sql.includes("user_entitlements")) return state.entitled ? { id: "entitlement-1" } : null;
              if (sql.includes("WHERE id = ? AND user_id = ?")) return state.sessionActive ? { id: user.session_id } : null;
              return null;
            }
          };
        }
      };
    }
  };
  return { env, user, state, getStreamAuthorizationQueryCount: () => streamAuthorizationQueries };
}

function favoriteFoldersEnvironment({ userId = "user-1", store = new Map() } = {}) {
  const env = testEnvironment();
  const user = { id: userId, email: userId + "@example.com", session_id: "session-" + userId, expires_at: "2099-01-01T00:00:00.000Z" };
  let favoriteReads = 0;
  let favoriteWrites = 0;
  env.DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() { return sql.includes("JOIN users") ? user : null; },
            async all() {
              if (!sql.includes("FROM user_favorite_folders")) return { results: [] };
              favoriteReads++;
              const saved = store.get(values[0]) || new Set();
              return { results: Array.from(saved, folder_key => ({ folder_key })) };
            },
            async run() {
              if (sql.startsWith("INSERT INTO user_favorite_folders")) {
                favoriteWrites++;
                if (!store.has(values[0])) store.set(values[0], new Set());
                store.get(values[0]).add(values[1]);
              } else if (sql.startsWith("DELETE FROM user_favorite_folders")) {
                favoriteWrites++;
                if (store.has(values[0])) store.get(values[0]).delete(values[1]);
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  return { env, user, store, getFavoriteReadCount: () => favoriteReads, getFavoriteWriteCount: () => favoriteWrites };
}

test("favoritos de pastas exigem sessão, mas não acesso vitalício", async () => {
  const fixture = favoriteFoldersEnvironment();
  const url = "https://worker.example/favorites/folders";
  const unauthenticatedGet = await musicWorker.fetch(new Request(url), fixture.env);
  assert.equal(unauthenticatedGet.status, 401);
  const unauthenticatedPost = await musicWorker.fetch(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderKey: "PSertanejo/Disco 1", favorite: true })
  }), fixture.env);
  assert.equal(unauthenticatedPost.status, 401);
  assert.equal(fixture.getFavoriteReadCount(), 0);
  assert.equal(fixture.getFavoriteWriteCount(), 0);

  const headers = { Authorization: "Bearer session-token" };
  const getResponse = await musicWorker.fetch(new Request(url, { headers }), fixture.env);
  assert.equal(getResponse.status, 200);
  assert.deepEqual((await getResponse.json()).favorites, []);
  const postResponse = await musicWorker.fetch(new Request(url, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ folderKey: "PSertanejo/Disco 1", favorite: true })
  }), fixture.env);
  assert.equal(postResponse.status, 200);
  assert.equal((await postResponse.json()).favorite, true);
});

test("favoritos de pastas são idempotentes ao marcar e desmarcar", async () => {
  const fixture = favoriteFoldersEnvironment();
  const url = "https://worker.example/favorites/folders";
  const headers = { Authorization: "Bearer session-token", "Content-Type": "application/json" };
  async function setFavorite(favorite) {
    return musicWorker.fetch(new Request(url, {
      method: "POST", headers,
      body: JSON.stringify({ folderKey: "PSertanejo/Disco 1", favorite })
    }), fixture.env);
  }
  assert.equal((await setFavorite(true)).status, 200);
  assert.equal((await setFavorite(true)).status, 200);
  assert.deepEqual(Array.from(fixture.store.get("user-1")), ["PSertanejo/Disco 1"]);
  assert.equal((await setFavorite(false)).status, 200);
  assert.equal((await setFavorite(false)).status, 200);
  assert.deepEqual(Array.from(fixture.store.get("user-1")), []);
});

test("favoritos ficam isolados por usuário e ignoram userId enviado pelo cliente", async () => {
  const store = new Map([
    ["user-1", new Set(["PFunk/Clássicos"])],
    ["user-2", new Set(["PPagode/Volume 1"])]
  ]);
  const first = favoriteFoldersEnvironment({ userId: "user-1", store });
  const second = favoriteFoldersEnvironment({ userId: "user-2", store });
  const url = "https://worker.example/favorites/folders";
  const firstResponse = await musicWorker.fetch(new Request(url, {
    headers: { Authorization: "Bearer user-one-token" }
  }), first.env);
  const secondResponse = await musicWorker.fetch(new Request(url, {
    headers: { Authorization: "Bearer user-two-token" }
  }), second.env);
  assert.deepEqual((await firstResponse.json()).favorites, ["PFunk/Clássicos"]);
  assert.deepEqual((await secondResponse.json()).favorites, ["PPagode/Volume 1"]);

  const added = await musicWorker.fetch(new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer user-one-token", "Content-Type": "application/json" },
    body: JSON.stringify({ folderKey: "PPagode/Volume 1", favorite: true, userId: "user-2" })
  }), first.env);
  assert.equal(added.status, 200);
  assert.equal(store.get("user-1").has("PPagode/Volume 1"), true);
  assert.deepEqual(Array.from(store.get("user-2")), ["PPagode/Volume 1"]);
});

test("chaves opacas distinguem a raiz e preservam o caminho bruto da pasta", async () => {
  const fixture = favoriteFoldersEnvironment();
  const url = "https://worker.example/favorites/folders";
  const headers = { Authorization: "Bearer session-token", "Content-Type": "application/json" };
  for (const folderKey of ["R", "PRock//Anos 80", "POutros\\Noites"]) {
    const response = await musicWorker.fetch(new Request(url, {
      method: "POST", headers, body: JSON.stringify({ folderKey, favorite: true })
    }), fixture.env);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(Array.from(fixture.store.get("user-1")), ["R", "PRock//Anos 80", "POutros\\Noites"]);
});

test("API de favoritos rejeita folderKey inválido, booleans ausentes e métodos não permitidos", async () => {
  const fixture = favoriteFoldersEnvironment();
  const url = "https://worker.example/favorites/folders";
  const headers = { Authorization: "Bearer session-token", "Content-Type": "application/json" };
  for (const body of [
    { folderKey: "", favorite: true },
    { folderKey: "Sertanejo/../outra", favorite: true },
    { folderKey: "Zrock/Disco", favorite: true },
    { folderKey: "Pbad\nkey", favorite: true },
    { folderKey: "P" + "x".repeat(1024), favorite: true },
    { folderKey: "PSertanejo/Disco", favorite: "true" }
  ]) {
    const response = await musicWorker.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), fixture.env);
    assert.equal(response.status, 400);
  }
  const methodResponse = await musicWorker.fetch(new Request(url, { method: "DELETE", headers }), fixture.env);
  assert.equal(methodResponse.status, 405);
  assert.equal(fixture.getFavoriteWriteCount(), 0);
});

function paymentReconciliationEnvironment() {
  const env = testEnvironment();
  const user = { id: "user-1", email: "test@example.com", session_id: "session-1", expires_at: "2099-01-01T00:00:00.000Z" };
  const state = {
    entitled: false,
    lastReconciledAt: null,
    paymentRows: 0,
    order: {
      id: "order-1",
      user_id: user.id,
      preference_id: "preference-1",
      amount_cents: 1500,
      currency_id: "BRL",
      status: "pending",
      created_at: "2026-11-20 20:00:00"
    }
  };
  env.MERCADOPAGO_ACCESS_TOKEN = "unit-test-access-token";
  env.DB = {
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            sql,
            values,
            async first() {
              if (sql.includes("JOIN users")) return user;
              if (sql.includes("FROM user_entitlements")) return state.entitled ? { id: "entitlement-1" } : null;
              if (sql.includes("SELECT status, created_at FROM checkout_orders")) {
                return { status: state.order.status, created_at: state.order.created_at };
              }
              if (sql.includes("FROM payments WHERE provider_payment_id")) return null;
              return null;
            },
            async all() {
              if (sql.includes("FROM checkout_orders") && sql.includes("last_reconciled_at")) {
                return { results: state.order.status === "pending" ? [{ ...state.order, last_reconciled_at: state.lastReconciledAt }] : [] };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE checkout_orders SET last_reconciled_at")) {
                const checkedAt = values[0];
                const cutoff = values[3];
                const due = !state.lastReconciledAt || state.lastReconciledAt <= cutoff;
                if (state.order.status === "pending" && due) {
                  state.lastReconciledAt = checkedAt;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    },
    async batch(statements) {
      const update = statements[0];
      if (!update.sql.includes("UPDATE checkout_orders")) return statements.map(() => ({ meta: { changes: 0 } }));
      const [paymentId, updatedAt, preferenceId, orderId, userId, approvedPaymentId, allowedPaymentId, expectedPreferenceId] = update.values;
      const allowedStatus = state.order.status === "pending" || (state.order.status === "approved" && state.order.provider_payment_id === approvedPaymentId);
      const allowedPayment = !state.order.provider_payment_id || state.order.provider_payment_id === allowedPaymentId;
      const allowedPreference = state.order.preference_id === expectedPreferenceId;
      if (orderId !== state.order.id || userId !== state.order.user_id || !allowedStatus || !allowedPayment || !allowedPreference) {
        return statements.map(() => ({ meta: { changes: 0 } }));
      }
      state.order.status = "approved";
      state.order.provider_payment_id = paymentId;
      state.order.preference_id = preferenceId;
      state.order.updated_at = updatedAt;
      state.entitled = true;
      state.paymentRows++;
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { env, user, state };
}

async function withMockedFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try { return await callback(); }
  finally { globalThis.fetch = originalFetch; }
}

function streamUrlFor(key, ticket) {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL("https://worker.example/stream/" + path);
  if (ticket) url.searchParams.set("ticket", ticket);
  return url;
}

test("cadastro gera hash PBKDF2 dentro do limite suportado pelo Worker Cloudflare", async () => {
  const env = testEnvironment();
  let storedPasswordHash = "";
  env.DB = {
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            sql,
            values,
            async first() { return null; },
            async run() { return { success: true }; }
          };
        }
      };
    },
    async batch(statements) {
      const userStatement = statements.find(statement => statement.sql.includes("INSERT INTO users"));
      storedPasswordHash = userStatement?.values?.[3] || "";
      return [];
    }
  };

  const response = await musicWorker.fetch(new Request("https://worker.example/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "new-user@example.com", password: "correct-horse-battery-staple" })
  }), env);

  assert.equal(response.status, 201);
  assert.equal(storedPasswordHash.split("$")[1], "100000");
});

test("recusa o catálogo sem sessão antes de listar objetos do R2", async () => {
  const env = testEnvironment();
  const response = await musicWorker.fetch(new Request("https://worker.example/catalog"), env);
  assert.equal(response.status, 401);
  assert.equal(env.MUSIC_BUCKET.listCallCount, 0);
});

test("conta autenticada sem entitlement recebe metadados, mas nenhum ticket de áudio", async () => {
  const { env } = authenticatedEnvironment({ entitled: false });
  const response = await musicWorker.fetch(new Request("https://worker.example/catalog", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env);
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.access.authenticated, true);
  assert.equal(catalog.access.lifetimeAccess, false);
  assert.equal(catalog.songs.length, testObjects.length);
  assert.ok(catalog.songs.every(song => song.streamUrl === ""));
  assert.ok(catalog.songs.every(song => !("trial" in song)));

  const blocked = await musicWorker.fetch(new Request(streamUrlFor("Funk/01 - Faixa A.mp3")), env);
  assert.equal(blocked.status, 401);
  assert.equal(env.MUSIC_BUCKET.headCallCount, 0);
});

test("agrega páginas do catálogo em uma resposta quando all=1", async () => {
  const { env } = authenticatedEnvironment({ entitled: false });
  const response = await musicWorker.fetch(new Request("https://worker.example/catalog?limit=1&all=1", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env);
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.songs.length, testObjects.length);
  assert.equal(catalog.pagesLoaded, testObjects.length);
  assert.equal(catalog.nextCursor, null);
  assert.equal(env.MUSIC_BUCKET.listCallCount, testObjects.length);
});

test("mantém o cursor normal e limita a dez páginas agregadas por resposta", async () => {
  const standard = authenticatedEnvironment({ entitled: false });
  const standardResponse = await musicWorker.fetch(new Request("https://worker.example/catalog?limit=1", {
    headers: { Authorization: "Bearer test-session-token" }
  }), standard.env);
  const standardCatalog = await standardResponse.json();
  assert.equal(standardCatalog.songs.length, 1);
  assert.equal(standardCatalog.pagesLoaded, 1);
  assert.equal(standardCatalog.nextCursor, "1");
  assert.equal(standard.env.MUSIC_BUCKET.listCallCount, 1);

  const objects = Array.from({ length: 11 }, (_, index) => ({
    key: `Funk/${String(index + 1).padStart(2, "0")} - Faixa ${index + 1}.mp3`
  }));
  const aggregated = authenticatedEnvironment({ entitled: false, objects });
  const aggregatedResponse = await musicWorker.fetch(new Request("https://worker.example/catalog?limit=1&all=1", {
    headers: { Authorization: "Bearer test-session-token" }
  }), aggregated.env);
  const aggregatedCatalog = await aggregatedResponse.json();
  assert.equal(aggregatedCatalog.songs.length, 10);
  assert.equal(aggregatedCatalog.pagesLoaded, 10);
  assert.equal(aggregatedCatalog.nextCursor, "10");
  assert.equal(aggregated.env.MUSIC_BUCKET.listCallCount, 10);
});

test("rejeita tickets trial assinados e não lê R2", async () => {
  const env = testEnvironment();
  const now = Math.floor(Date.now() / 1000);
  const ticket = await mediaTicket(MEDIA_SECRET, {
    v: 1,
    scope: "trial",
    sub: null,
    sid: null,
    exp: now + 600
  });
  const response = await musicWorker.fetch(new Request(streamUrlFor("Funk/01 - Faixa A.mp3", ticket)), env);
  assert.equal(response.status, 401);
  assert.equal(env.MUSIC_BUCKET.headCallCount, 0);
});

test("entitlement vitalício ativo emite tickets premium e permite o streaming protegido", async () => {
  const { env, getStreamAuthorizationQueryCount } = authenticatedEnvironment({ entitled: true });
  const catalogResponse = await musicWorker.fetch(new Request("https://worker.example/catalog", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.access.lifetimeAccess, true);
  assert.ok(catalog.songs.every(song => /ticket=/.test(song.streamUrl)));

  const song = catalog.songs.find(item => item.key === "Funk/01 - Faixa A.mp3");
  const streamResponse = await musicWorker.fetch(new Request(song.streamUrl), env);
  assert.equal(streamResponse.status, 200);
  assert.equal(await streamResponse.text(), "AUDIO A");
  assert.equal(getStreamAuthorizationQueryCount(), 1);
});

test("revalida sessão e entitlement em cada pedido de mídia", async () => {
  const { env, state, getStreamAuthorizationQueryCount } = authenticatedEnvironment({ entitled: true });
  const catalogResponse = await musicWorker.fetch(new Request("https://worker.example/catalog", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env);
  const catalog = await catalogResponse.json();
  const song = catalog.songs[0];

  state.sessionActive = false;
  const expiredSession = await musicWorker.fetch(new Request(song.streamUrl), env);
  assert.equal(expiredSession.status, 401);

  state.sessionActive = true;
  state.entitled = false;
  const removedEntitlement = await musicWorker.fetch(new Request(song.streamUrl), env);
  assert.equal(removedEntitlement.status, 403);
  assert.equal(getStreamAuthorizationQueryCount(), 2);
  assert.equal(env.MUSIC_BUCKET.headCallCount, 0);
});

test("aceita intervalos simples, abertos e sufixos; recusa ranges inválidos", () => {
  assert.deepEqual(parseByteRange("bytes=2-5", 10), { offset: 2, length: 4 });
  assert.deepEqual(parseByteRange("bytes=7-", 10), { offset: 7, length: 3 });
  assert.deepEqual(parseByteRange("bytes=-4", 10), { offset: 6, length: 4 });
  assert.deepEqual(parseByteRange("bytes=2-99", 10), { offset: 2, length: 8 });
  assert.equal(parseByteRange("bytes=10-", 10), null);
  assert.equal(parseByteRange("bytes=5-2", 10), null);
  assert.equal(parseByteRange("bytes=0-1,4-5", 10), null);
});

test("valida o manifesto HMAC oficial Mercado Pago e rejeita adulterações", async () => {
  const secret = "unit-test-webhook-secret";
  const dataId = "123456789";
  const requestId = "4ed4fa2b-0b31-42ec-a62f-ad793c486c59";
  const timestamp = "1781009491";
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const signature = await hmacHex(secret, manifest);
  assert.equal(await verifyWebhookSignature(`ts=${timestamp},v1=${signature}`, requestId, dataId, secret), true);
  assert.equal(await verifyWebhookSignature(`ts=${timestamp},v1=${signature}`, requestId, "987654321", secret), false);
  assert.equal(await verifyWebhookSignature(`ts=${timestamp},v1=${signature}`, requestId, dataId, "wrong-secret"), false);
});

test("streamR2 devolve 206 e os bytes correspondentes a Range", async () => {
  const allBytes = encoder.encode("0123456789");
  const env = {
    MUSIC_BUCKET: {
      async head() { return fakeR2Object(allBytes); },
      async get(_key, options) {
        if (!options || !options.range) return fakeR2Object(allBytes);
        const { offset, length } = options.range;
        return fakeR2Object(allBytes.slice(offset, offset + length), allBytes.length);
      }
    }
  };
  const request = new Request("https://worker.example/stream/Funk/track.mp3", {
    headers: { Range: "bytes=2-5" }
  });
  const response = await streamR2(request, env, "Funk/track.mp3");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(response.headers.get("Content-Length"), "4");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(await response.text(), "2345");
});

test("streamR2 recusa range fora do tamanho com Content-Range 416", async () => {
  const bytes = encoder.encode("0123456789");
  const env = {
    MUSIC_BUCKET: {
      async head() { return fakeR2Object(bytes); },
      async get() { throw new Error("get não deve ser chamado em range inválido"); }
    }
  };
  const response = await streamR2(new Request("https://worker.example/stream/a.mp3", {
    headers: { Range: "bytes=10-" }
  }), env, "a.mp3");
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("Content-Range"), "bytes */10");
});

test("pagamentos/status reconcilia pagamento aprovado e correspondente sem confiar em IDs do cliente", async () => {
  const { env, state } = paymentReconciliationEnvironment();
  let searchCalls = 0;
  let detailCalls = 0;
  const response = await withMockedFetch(async (input, init) => {
    const url = new URL(String(input));
      assert.equal(init.headers.Authorization, "Bearer unit-test-access-token");
      if (url.pathname === "/v1/payments/search") {
        searchCalls++;
        assert.equal(url.searchParams.get("external_reference"), "order-1");
        assert.equal(url.searchParams.get("status"), "approved");
        assert.equal(url.searchParams.get("limit"), "3");
        return new Response(JSON.stringify({ results: [{ id: "payment-1" }] }), { status: 200 });
      }
    if (url.pathname === "/v1/payments/payment-1") {
      detailCalls++;
      return new Response(JSON.stringify({
        id: "payment-1",
        status: "approved",
        live_mode: true,
        external_reference: "order-1",
        preference_id: "preference-1",
        transaction_amount: 15,
        currency_id: "BRL",
        date_approved: "2026-11-20T22:00:00.000Z"
      }), { status: 200 });
    }
    throw new Error("Unexpected Mercado Pago URL");
  }, () => musicWorker.fetch(new Request("https://worker.example/payments/status?external_reference=attacker-value", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env));

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.lifetimeAccess, true);
  assert.equal(result.paymentStatus, "approved");
  assert.equal(state.order.provider_payment_id, "payment-1");
  assert.equal(state.paymentRows, 1);
  assert.equal(searchCalls, 1);
  assert.equal(detailCalls, 1);
});

test("pagamentos/status aceita resultados de busca do Mercado Pago envolvidos em array", async () => {
  const { env, state } = paymentReconciliationEnvironment();
  const response = await withMockedFetch(async input => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/payments/search") {
      return new Response(JSON.stringify([{ paging: { total: 1 }, results: [{ id: "payment-1" }] }]), { status: 200 });
    }
    if (url.pathname === "/v1/payments/payment-1") {
      return new Response(JSON.stringify({
        id: "payment-1",
        status: "approved",
        live_mode: true,
        external_reference: "order-1",
        preference_id: "preference-1",
        transaction_amount: 15,
        currency_id: "BRL",
        date_approved: "2026-11-20T22:00:00.000Z"
      }), { status: 200 });
    }
    throw new Error("Unexpected Mercado Pago URL");
  }, () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).lifetimeAccess, true);
  assert.equal(state.order.provider_payment_id, "payment-1");
  assert.equal(state.paymentRows, 1);
});

test("corrige preferência local divergente somente após verificar no Mercado Pago o pedido e o item exatos", async () => {
  const { env, state } = paymentReconciliationEnvironment();
  const originalPreferenceId = state.order.preference_id;
  const paymentPreferenceId = "verified-payment-preference";
  let preferenceCalls = 0;
  let summary;
  const originalInfo = console.info;
  console.info = (_eventName, details) => { summary = details; };
  try {
    const response = await withMockedFetch(async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init.headers.Authorization, "Bearer unit-test-access-token");
      if (url.pathname === "/v1/payments/search") {
        return new Response(JSON.stringify({ results: [{ id: "payment-1" }] }), { status: 200 });
      }
      if (url.pathname === "/v1/payments/payment-1") {
        return new Response(JSON.stringify({
          id: "payment-1",
          status: "approved",
          live_mode: true,
          external_reference: "order-1",
          preference_id: paymentPreferenceId,
          transaction_amount: 15,
          currency_id: "BRL",
          date_approved: "2026-11-20T22:00:00.000Z"
        }), { status: 200 });
      }
      if (url.pathname === `/checkout/preferences/${paymentPreferenceId}`) {
        preferenceCalls++;
        return new Response(JSON.stringify({
          id: paymentPreferenceId,
          external_reference: "order-1",
          items: [{ id: "music-vip-lifetime", quantity: 1, unit_price: "15.00", currency_id: "BRL" }]
        }), { status: 200 });
      }
      throw new Error("Unexpected Mercado Pago URL");
    }, () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
      headers: { Authorization: "Bearer test-session-token" }
    }), env));

    assert.equal(response.status, 200);
    assert.equal((await response.json()).lifetimeAccess, true);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(preferenceCalls, 1);
  assert.equal(state.order.preference_id, paymentPreferenceId);
  assert.notEqual(state.order.preference_id, originalPreferenceId);
  assert.equal(state.order.status, "approved");
  assert.equal(state.paymentRows, 1);
  assert.equal(summary.preferenceVerification.attempts, 1);
  assert.equal(summary.preferenceVerification.verified, 1);
  assert.equal(summary.entitlementsGranted, 1);
  assert.doesNotMatch(JSON.stringify(summary), /verified-payment-preference|payment-1|order-1|15\.00/);
});

test("mantém pendente e não repara a preferência se a preferência remota apontar para outro pedido", async () => {
  const { env, state } = paymentReconciliationEnvironment();
  const originalPreferenceId = state.order.preference_id;
  const response = await withMockedFetch(async input => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/payments/search") {
      return new Response(JSON.stringify({ results: [{ id: "payment-1" }] }), { status: 200 });
    }
    if (url.pathname === "/v1/payments/payment-1") {
      return new Response(JSON.stringify({
        id: "payment-1",
        status: "approved",
        live_mode: true,
        external_reference: "order-1",
        preference_id: "other-preference",
        transaction_amount: 15,
        currency_id: "BRL"
      }), { status: 200 });
    }
    if (url.pathname === "/checkout/preferences/other-preference") {
      return new Response(JSON.stringify({
        id: "other-preference",
        external_reference: "different-order",
        items: [{ id: "music-vip-lifetime", quantity: 1, unit_price: "15.00", currency_id: "BRL" }]
      }), { status: 200 });
    }
    throw new Error("Unexpected Mercado Pago URL");
  }, () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env));

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.lifetimeAccess, false);
  assert.equal(result.paymentStatus, "pending");
  assert.equal(state.order.status, "pending");
  assert.equal(state.order.preference_id, originalPreferenceId);
  assert.equal(state.paymentRows, 0);
});

test("reconciliação registra somente métricas agregadas e não expõe identificadores", async () => {
  const { env } = paymentReconciliationEnvironment();
  const originalInfo = console.info;
  let summary;
  console.info = (eventName, details) => {
    assert.equal(eventName, "MUSIC_PAYMENT_RECONCILIATION");
    summary = details;
  };
  try {
    await withMockedFetch(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/payments/search") {
        return new Response(JSON.stringify({ results: [{ id: "private-payment-id" }] }), { status: 200 });
      }
      if (url.pathname === "/v1/payments/private-payment-id") {
        return new Response(JSON.stringify({
          id: "private-payment-id",
          status: "approved",
          live_mode: true,
          external_reference: "different-private-order",
          preference_id: "preference-1",
          transaction_amount: 15,
          currency_id: "BRL"
        }), { status: 200 });
      }
      throw new Error("Unexpected Mercado Pago URL");
    }, () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
      headers: { Authorization: "Bearer test-session-token" }
    }), env));
  } finally {
    console.info = originalInfo;
  }

  assert.equal(summary.resultCount, 1);
  assert.equal(summary.detailsFetched, 1);
  assert.equal(summary.mismatches.externalReference, 1);
  assert.equal(summary.validatedPayments, 0);
  assert.equal(summary.entitlementsGranted, 0);
  assert.doesNotMatch(JSON.stringify(summary), /private-payment-id|different-private-order|preference-1|15/);
});

test("pagamentos/status não consulta o Mercado Pago sem sessão autenticada", async () => {
  const { env } = paymentReconciliationEnvironment();
  let fetchCalls = 0;
  const response = await withMockedFetch(async () => {
    fetchCalls++;
    throw new Error("fetch não deve ser chamado sem autenticação");
  }, () => musicWorker.fetch(new Request("https://worker.example/payments/status"), env));

  assert.equal(response.status, 401);
  assert.equal(fetchCalls, 0);
});

test("reconciliação não libera acesso para pagamento não aprovado ou dados divergentes", async () => {
  const invalidPayments = [
    { status: "pending" },
    { live_mode: false },
    { id: "different-payment" },
    { external_reference: "different-order" },
    { preference_id: "different-preference" },
    { transaction_amount: 14.99 },
    { currency_id: "USD" }
  ];

  for (const overrides of invalidPayments) {
    const { env, state } = paymentReconciliationEnvironment();
    const response = await withMockedFetch(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/payments/search") {
        return new Response(JSON.stringify({ results: [{ id: "payment-1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: "payment-1",
        status: "approved",
        live_mode: true,
        external_reference: "order-1",
        preference_id: "preference-1",
        transaction_amount: 15,
        currency_id: "BRL",
        date_approved: "2026-11-20T22:00:00.000Z",
        ...overrides
      }), { status: 200 });
    }, () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
      headers: { Authorization: "Bearer test-session-token" }
    }), env));

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.lifetimeAccess, false);
    assert.equal(result.paymentStatus, "pending");
    assert.equal(state.order.status, "pending");
    assert.equal(state.paymentRows, 0);
  }
});

test("reconciliação mantém pedido pendente em erro do provedor e limita tentativas repetidas", async () => {
  const { env, state } = paymentReconciliationEnvironment();
  let searchCalls = 0;
  const mockFetch = async () => {
    searchCalls++;
    return new Response("temporarily unavailable", { status: 503 });
  };
  const request = () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
    headers: { Authorization: "Bearer test-session-token" }
  }), env);

  await withMockedFetch(mockFetch, async () => {
    const first = await request();
    const second = await request();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  });

  assert.equal(searchCalls, 1);
  assert.equal(state.order.status, "pending");
  assert.equal(state.entitled, false);
});


test("reconcilia por Merchant Order quando o pagamento não traz preference_id, validando a preferência e o item exatos", async () => {
  const { env, state } = paymentReconciliationEnvironment();
  const preferenceId = "verified-merchant-order-preference";
  let merchantOrderCalls = 0;
  let preferenceCalls = 0;
  let summary;
  const originalInfo = console.info;
  console.info = (_eventName, details) => { summary = details; };
  try {
    const response = await withMockedFetch(async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init.headers.Authorization, "Bearer unit-test-access-token");
      if (url.pathname === "/v1/payments/search") {
        return new Response(JSON.stringify({ results: [{ id: "payment-1" }] }), { status: 200 });
      }
      if (url.pathname === "/v1/payments/payment-1") {
        return new Response(JSON.stringify({
          id: "payment-1",
          status: "approved",
          live_mode: true,
          external_reference: "order-1",
          preference_id: null,
          transaction_amount: 15,
          currency_id: "BRL",
          date_approved: "2026-11-20T22:00:00.000Z"
        }), { status: 200 });
      }
      if (url.pathname === "/merchant_orders/search") {
        merchantOrderCalls++;
        assert.equal(url.searchParams.get("external_reference"), "order-1");
        return new Response(JSON.stringify({
          elements: [{
            id: "merchant-order-1",
            status: "closed",
            order_status: "paid",
            external_reference: "order-1",
            preference_id: preferenceId,
            total_amount: 15,
            paid_amount: 15,
            payments: [{ id: "payment-1", status: "approved", transaction_amount: 15, currency_id: "BRL" }],
            items: [{ id: "music-vip-lifetime", quantity: 1, unit_price: 15, currency_id: "BRL" }]
          }],
          total: 1
        }), { status: 200 });
      }
      if (url.pathname === `/checkout/preferences/${preferenceId}`) {
        preferenceCalls++;
        return new Response(JSON.stringify({
          id: preferenceId,
          external_reference: "order-1",
          items: [{ id: "music-vip-lifetime", quantity: 1, unit_price: "15.00", currency_id: "BRL" }]
        }), { status: 200 });
      }
      throw new Error("Unexpected Mercado Pago URL");
    }, () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
      headers: { Authorization: "Bearer test-session-token" }
    }), env));

    assert.equal(response.status, 200);
    assert.equal((await response.json()).lifetimeAccess, true);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(merchantOrderCalls, 1);
  assert.equal(preferenceCalls, 1);
  assert.equal(state.order.preference_id, preferenceId);
  assert.equal(state.order.status, "approved");
  assert.equal(state.paymentRows, 1);
  assert.equal(summary.merchantOrderVerification.attempts, 1);
  assert.equal(summary.merchantOrderVerification.verified, 1);
  assert.equal(summary.preferenceVerification.verified, 1);
  assert.equal(summary.entitlementsGranted, 1);
  assert.doesNotMatch(JSON.stringify(summary), /merchant-order-1|payment-1|order-1|verified-merchant-order-preference|15\.00/);
});

test("mantém pendente se Merchant Order não confirmar o item MUSIC VIP exato", async () => {
  const { env, state } = paymentReconciliationEnvironment();
  const originalPreferenceId = state.order.preference_id;
  let preferenceCalls = 0;
  let summary;
  const originalInfo = console.info;
  console.info = (_eventName, details) => { summary = details; };
  try {
    const response = await withMockedFetch(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/payments/search") {
        return new Response(JSON.stringify({ results: [{ id: "payment-1" }] }), { status: 200 });
      }
      if (url.pathname === "/v1/payments/payment-1") {
        return new Response(JSON.stringify({
          id: "payment-1",
          status: "approved",
          live_mode: true,
          external_reference: "order-1",
          preference_id: null,
          transaction_amount: 15,
          currency_id: "BRL"
        }), { status: 200 });
      }
      if (url.pathname === "/merchant_orders/search") {
        return new Response(JSON.stringify({
          elements: [{
            id: "merchant-order-1",
            status: "closed",
            order_status: "paid",
            external_reference: "order-1",
            preference_id: "other-preference",
            total_amount: 15,
            paid_amount: 15,
            payments: [{ id: "payment-1", status: "approved", transaction_amount: 15, currency_id: "BRL" }],
            items: [{ id: "other-product", quantity: 1, unit_price: 15, currency_id: "BRL" }]
          }],
          total: 1
        }), { status: 200 });
      }
      if (url.pathname === "/checkout/preferences/other-preference") {
        preferenceCalls++;
        return new Response(JSON.stringify({
          id: "other-preference",
          external_reference: "order-1",
          items: [{ id: "other-product", quantity: 1, unit_price: 15, currency_id: "BRL" }]
        }), { status: 200 });
      }
      throw new Error("Unexpected Mercado Pago URL");
    }, () => musicWorker.fetch(new Request("https://worker.example/payments/status", {
      headers: { Authorization: "Bearer test-session-token" }
    }), env));

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.lifetimeAccess, false);
    assert.equal(result.paymentStatus, "pending");
  } finally {
    console.info = originalInfo;
  }

  assert.equal(preferenceCalls, 0);
  assert.equal(state.order.status, "pending");
  assert.equal(state.order.preference_id, originalPreferenceId);
  assert.equal(state.paymentRows, 0);
  assert.equal(summary.merchantOrderVerification.attempts, 1);
  assert.equal(summary.merchantOrderVerification.itemMismatches, 1);
  assert.equal(summary.merchantOrderVerification.verified, 0);
  assert.equal(summary.entitlementsGranted, 0);
});

function webhookTestEnvironment() {
  const env = testEnvironment();
  const order = {
    id: "order-1",
    user_id: "user-1",
    preference_id: "preference-1",
    amount_cents: 1500,
    currency_id: "BRL",
    status: "pending"
  };
  const pixOrder = {
    id: "pix-order-1",
    user_id: "user-1",
    provider_payment_id: "payment-pix-1",
    amount_cents: 1500,
    currency_id: "BRL",
    status: "pending",
    qr_code: "000201-pix-test",
    qr_code_base64: "aVZCT1J3MEtHZ289"
  };
  let batchCalls = 0;
  env.MERCADOPAGO_ACCESS_TOKEN = "unit-test-access-token";
  env.MERCADOPAGO_WEBHOOK_SECRET = "unit-test-webhook-secret";
  env.DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM checkout_orders") && sql.includes("WHERE id = ?")) {
                return values[0] === order.id ? order : null;
              }
              if (sql.includes("FROM pix_checkout_orders") && sql.includes("WHERE id = ?")) {
                return values[0] === pixOrder.id ? pixOrder : null;
              }
              if (sql.includes("FROM checkout_orders") && sql.includes("WHERE preference_id = ?")) {
                return values[0] === order.preference_id ? order : null;
              }
              if (sql.includes("FROM payments WHERE provider_payment_id")) return null;
              return null;
            }
          };
        }
      };
    },
    async batch(statements) {
      batchCalls++;
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { env, order, pixOrder, batchCalls: () => batchCalls };
}

function pixCheckoutTestEnvironment() {
  const env = testEnvironment();
  const user = { id: "user-1", email: "test@example.com", session_id: "session-1", expires_at: "2099-01-01T00:00:00.000Z" };
  const state = { order: null };
  env.MERCADOPAGO_ACCESS_TOKEN = "unit-test-access-token";
  env.MERCADOPAGO_WEBHOOK_SECRET = "unit-test-webhook-secret";
  env.DB = {
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            sql,
            values,
            async first() {
              if (sql.includes("JOIN users")) return user;
              if (sql.includes("FROM user_entitlements")) return null;
              if (sql.includes("FROM pix_checkout_orders") && sql.includes("WHERE user_id = ?")) return null;
              if (sql.includes("FROM payments WHERE provider_payment_id")) return null;
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO pix_checkout_orders")) {
                state.order = {
                  id: values[0], user_id: values[1], provider: "mercadopago",
                  amount_cents: values[2], currency_id: "BRL", status: "creating"
                };
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE pix_checkout_orders") && sql.includes("SET provider_payment_id")) {
                Object.assign(state.order, {
                  provider_payment_id: values[0], status: values[1], qr_code: values[2],
                  qr_code_base64: values[3], ticket_url: values[4], updated_at: values[5]
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    },
    async batch(statements) { return statements.map(() => ({ meta: { changes: 1 } })); }
  };
  return { env, user, state };
}

async function signedWebhookRequest(secret, paymentId) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = "webhook-request-1";
  const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
  const signature = await hmacHex(secret, manifest);
  return new Request(`https://worker.example/payments/webhook?type=payment&data.id=${encodeURIComponent(paymentId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": `ts=${timestamp},v1=${signature}`,
      "x-request-id": requestId
    },
    body: JSON.stringify({ type: "payment", data: { id: paymentId } })
  });
}

test("webhook não persiste nem libera pagamento aprovado em modo de teste", async () => {
  const { env, batchCalls } = webhookTestEnvironment();
  const request = await signedWebhookRequest(env.MERCADOPAGO_WEBHOOK_SECRET, "payment-1");
  const response = await withMockedFetch(async input => {
    assert.equal(new URL(String(input)).pathname, "/v1/payments/payment-1");
    return new Response(JSON.stringify({
      id: "payment-1",
      status: "approved",
      live_mode: false,
      external_reference: "order-1",
      preference_id: "preference-1",
      transaction_amount: 15,
      currency_id: "BRL"
    }), { status: 200 });
  }, () => musicWorker.fetch(request, env));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, true);
  assert.equal(batchCalls(), 0);
});

test("webhook exige referência exata do pedido mesmo quando a preferência coincide", async () => {
  const { env, batchCalls } = webhookTestEnvironment();
  const request = await signedWebhookRequest(env.MERCADOPAGO_WEBHOOK_SECRET, "payment-1");
  const originalWarn = console.warn;
  console.warn = () => {};
  let response;
  try {
    response = await withMockedFetch(async input => {
      assert.equal(new URL(String(input)).pathname, "/v1/payments/payment-1");
      return new Response(JSON.stringify({
        id: "payment-1",
        status: "approved",
        live_mode: true,
        external_reference: "",
        preference_id: "preference-1",
        transaction_amount: 15,
        currency_id: "BRL"
      }), { status: 200 });
    }, () => musicWorker.fetch(request, env));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, true);
  assert.equal(batchCalls(), 0);
});

test("webhook continua persistindo pagamento de produção com referência e preferência exatas", async () => {
  const { env, batchCalls } = webhookTestEnvironment();
  const request = await signedWebhookRequest(env.MERCADOPAGO_WEBHOOK_SECRET, "payment-1");
  const response = await withMockedFetch(async input => {
    assert.equal(new URL(String(input)).pathname, "/v1/payments/payment-1");
    return new Response(JSON.stringify({
      id: "payment-1",
      status: "approved",
      live_mode: true,
      external_reference: "order-1",
      preference_id: "preference-1",
      transaction_amount: 15,
      currency_id: "BRL"
    }), { status: 200 });
  }, () => musicWorker.fetch(request, env));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(batchCalls(), 1);
});

test("Pix cria QR dinâmico vinculado ao pedido, com idempotência e sem cobrança real nos testes", async () => {
  const { env, state } = pixCheckoutTestEnvironment();
  let requestBody;
  const response = await withMockedFetch(async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/v1/payments");
    assert.equal(init.headers["X-Idempotency-Key"], state.order.id);
    requestBody = JSON.parse(init.body);
    assert.equal(requestBody.payment_method_id, "pix");
    assert.equal(requestBody.transaction_amount, 15);
    assert.equal(requestBody.payer.email, "test@example.com");
    assert.equal(requestBody.notification_url, "https://worker.example/payments/webhook");
    return new Response(JSON.stringify({
      id: "payment-pix-1",
      status: "pending",
      live_mode: true,
      payment_method_id: "pix",
      external_reference: requestBody.external_reference,
      transaction_amount: 15,
      currency_id: "BRL",
      point_of_interaction: { transaction_data: {
        qr_code: "000201-pix-test",
        qr_code_base64: "aVZCT1J3MEtHZ289",
        ticket_url: "https://www.mercadopago.com.br/payments/123/ticket"
      } }
    }), { status: 201 });
  }, () => musicWorker.fetch(new Request("https://worker.example/payments/pix", {
    method: "POST",
    headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" },
    body: "{}"
  }), env));

  const result = await response.json();
  assert.equal(response.status, 201);
  assert.equal(result.pixPayment.qrCode, "000201-pix-test");
  assert.equal(result.pixPayment.status, "pending");
  assert.equal(state.order.id, requestBody.external_reference);
  assert.equal(state.order.provider_payment_id, "payment-pix-1");
  assert.equal(state.order.status, "pending");
});

test("webhook Pix libera acesso com pagamento assinado e correspondência exata, sem exigir preference_id", async () => {
  const { env, batchCalls } = webhookTestEnvironment();
  const request = await signedWebhookRequest(env.MERCADOPAGO_WEBHOOK_SECRET, "payment-pix-1");
  const response = await withMockedFetch(async input => {
    assert.equal(new URL(String(input)).pathname, "/v1/payments/payment-pix-1");
    return new Response(JSON.stringify({
      id: "payment-pix-1",
      status: "approved",
      live_mode: true,
      external_reference: "pix-order-1",
      payment_method_id: "pix",
      transaction_amount: 15,
      currency_id: "BRL"
    }), { status: 200 });
  }, () => musicWorker.fetch(request, env));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(batchCalls(), 1);
});

test("webhook Pix não aceita outro ID de pagamento mesmo com a referência do pedido correta", async () => {
  const { env, batchCalls } = webhookTestEnvironment();
  const request = await signedWebhookRequest(env.MERCADOPAGO_WEBHOOK_SECRET, "payment-other-1");
  const response = await withMockedFetch(async () => new Response(JSON.stringify({
    id: "payment-other-1",
    status: "approved",
    live_mode: true,
    external_reference: "pix-order-1",
    payment_method_id: "pix",
    transaction_amount: 15,
    currency_id: "BRL"
  }), { status: 200 }), () => musicWorker.fetch(request, env));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, true);
  assert.equal(batchCalls(), 0);
});
