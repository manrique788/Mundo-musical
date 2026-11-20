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
