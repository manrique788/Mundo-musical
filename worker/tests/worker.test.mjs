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

function testEnvironment() {
  const audio = new Map([
    ["Funk/01 - Faixa A.mp3", encoder.encode("AUDIO A")],
    ["Funk/02 - Faixa B.mp3", encoder.encode("AUDIO B")],
    ["Pagode/01 - Faixa C.mp3", encoder.encode("AUDIO C")]
  ]);
  let headCalls = 0;
  let listCalls = 0;
  const bucket = {
    async list() { listCalls++; return { objects: testObjects, truncated: false }; },
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

function authenticatedEnvironment({ entitled = false, sessionActive = true } = {}) {
  const env = testEnvironment();
  const user = { id: "user-1", email: "test@example.com", session_id: "session-1", expires_at: "2099-01-01T00:00:00.000Z" };
  const state = { entitled, sessionActive };
  env.DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
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
  return { env, user, state };
}

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
  const { env } = authenticatedEnvironment({ entitled: true });
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
});

test("revalida sessão e entitlement em cada pedido de mídia", async () => {
  const { env, state } = authenticatedEnvironment({ entitled: true });
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
  return { env, order, batchCalls: () => batchCalls };
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
