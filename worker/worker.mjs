const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 100000;
const PREMIUM_AMOUNT_CENTS = 1500;
const MEDIA_TICKET_TTL_SECONDS = 4 * 60 * 60;
const PAYMENT_RECONCILE_INTERVAL_MS = 15 * 1000;
const PAYMENT_RECONCILE_ORDER_LIMIT = 5;
const PAYMENT_RECONCILE_PAYMENT_LIMIT = 3;
const SITE_URL = "https://manrique788.github.io/Mundo-musical/";
const AUDIO_EXTENSION = /\.(mp3|m4a|wav|ogg|aac|flac)$/i;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, If-Range",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, ETag",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store"
  };
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(corsHeaders());
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

async function createPasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations: PASSWORD_ITERATIONS,
    hash: "SHA-256"
  }, key, 256);
  return ["pbkdf2", PASSWORD_ITERATIONS, toBase64Url(salt), toBase64Url(new Uint8Array(bits))].join("$");
}

async function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > PASSWORD_ITERATIONS) return false;
    const salt = fromBase64Url(parts[2]);
    const expected = fromBase64Url(parts[3]);
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    }, key, 256);
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index];
    return difference === 0;
  } catch {
    return false;
  }
}

async function prepareSession(env, userId) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = toBase64Url(tokenBytes);
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const statement = env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), userId, tokenHash, expiresAt);
  return { token, tokenHash, expiresAt, statement };
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

async function authenticate(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(
    `SELECT users.id, users.email, sessions.id AS session_id, sessions.expires_at
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
  ).bind(tokenHash, new Date().toISOString()).first();
}

async function hasLifetimeAccess(env, userId) {
  if (!userId) return false;
  const entitlement = await env.DB.prepare(
    `SELECT id FROM user_entitlements
     WHERE user_id = ? AND plan = 'lifetime' AND status = 'active'
     LIMIT 1`
  ).bind(userId).first();
  return Boolean(entitlement);
}

async function sessionIsActive(env, sessionId, userId) {
  if (!sessionId || !userId) return false;
  const session = await env.DB.prepare(
    `SELECT id FROM sessions
     WHERE id = ? AND user_id = ? AND expires_at > ?
     LIMIT 1`
  ).bind(sessionId, userId, new Date().toISOString()).first();
  return Boolean(session);
}

async function createMediaTicket(env, claims) {
  if (!env.MEDIA_SIGNING_SECRET) return null;
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    scope: claims.scope,
    sub: claims.userId || null,
    sid: claims.sessionId || null,
    exp: issuedAt + MEDIA_TICKET_TTL_SECONDS
  };
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.MEDIA_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  return encodedPayload + "." + toBase64Url(new Uint8Array(signature));
}

function safeEqual(left, right) {
  const a = encoder.encode(String(left || "").toLowerCase());
  const b = encoder.encode(String(right || "").toLowerCase());
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function verifyMediaTicket(env, ticket) {
  try {
    if (!env.MEDIA_SIGNING_SECRET || typeof ticket !== "string" || ticket.length > 4096) return null;
    const parts = ticket.split(".");
    if (parts.length !== 2) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.MEDIA_SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(parts[0]));
    if (!safeEqual(toBase64Url(new Uint8Array(signature)), parts[1])) return null;
    const claims = JSON.parse(decoder.decode(fromBase64Url(parts[0])));
    const now = Math.floor(Date.now() / 1000);
    if (claims.v !== 1 || !Number.isInteger(claims.exp) || claims.exp <= now) return null;
    if (claims.exp > now + MEDIA_TICKET_TTL_SECONDS + 60) return null;
    if (claims.scope !== "premium") return null;
    return claims;
  } catch {
    return null;
  }
}

function folderFromKey(key) {
  const parts = String(key || "").split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "Outros";
}

function encodeObjectKey(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

function parseObjectKey(pathname) {
  const encoded = pathname.slice("/stream/".length);
  if (!encoded || encoded.length > 2048) return null;
  try {
    const parts = encoded.split("/").map(part => decodeURIComponent(part));
    if (parts.some(part => !part || part === "." || part === ".." || /[\\\0]/.test(part))) return null;
    const key = parts.join("/");
    if (key.length > 1024) return null;
    return key;
  } catch {
    return null;
  }
}

export function parseByteRange(value, totalSize) {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || typeof value !== "string") return null;
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const length = Math.min(suffixLength, totalSize);
    return { offset: totalSize - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || offset >= totalSize || requestedEnd < offset) return null;
  const end = Math.min(requestedEnd, totalSize - 1);
  return { offset, length: end - offset + 1 };
}

function streamHeaders() {
  const headers = new Headers(corsHeaders());
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function audioContentType(key, storedType) {
  if (storedType && storedType !== "application/octet-stream") return storedType;
  const extension = String(key).split(".").pop().toLowerCase();
  const types = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac"
  };
  return types[extension] || "application/octet-stream";
}

function ifRangeMatches(value, metadata) {
  if (!value) return true;
  if (value === metadata.httpEtag || value === metadata.etag) return true;
  if (metadata.uploaded && value === new Date(metadata.uploaded).toUTCString()) return true;
  return false;
}

export async function streamR2(request, env, key) {
  const metadata = await env.MUSIC_BUCKET.head(key);
  if (!metadata) return json({ error: "Faixa não encontrada" }, 404);

  const rangeHeader = request.headers.get("Range");
  const useRange = Boolean(rangeHeader) && ifRangeMatches(request.headers.get("If-Range"), metadata);
  const range = useRange ? parseByteRange(rangeHeader, metadata.size) : null;
  const headers = streamHeaders();
  if (typeof metadata.writeHttpMetadata === "function") metadata.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Content-Type", audioContentType(key, metadata.httpMetadata && metadata.httpMetadata.contentType));
  if (metadata.httpEtag) headers.set("ETag", metadata.httpEtag);
  else if (metadata.etag) headers.set("ETag", '"' + metadata.etag + '"');

  if (useRange && !range) {
    headers.set("Content-Range", "bytes */" + metadata.size);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, headers });
  }

  if (request.method === "HEAD") {
    if (range) {
      headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      headers.set("Content-Length", String(range.length));
      return new Response(null, { status: 206, headers });
    }
    headers.set("Content-Length", String(metadata.size));
    return new Response(null, { status: 200, headers });
  }

  const object = range
    ? await env.MUSIC_BUCKET.get(key, { range })
    : await env.MUSIC_BUCKET.get(key);
  if (!object || !object.body) return json({ error: "Faixa não encontrada" }, 404);
  if (typeof object.writeHttpMetadata === "function") object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Content-Type", audioContentType(key, object.httpMetadata && object.httpMetadata.contentType));
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(metadata.size));
  return new Response(object.body, { status: 200, headers });
}

async function registerAccount(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Dados inválidos" }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Informe um e-mail válido" }, 400);
  if (password.length < 8 || password.length > 128) return json({ error: "A senha deve ter entre 8 e 128 caracteres" }, 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return json({ error: "Este e-mail já está cadastrado" }, 409);

  const userId = crypto.randomUUID();
  const passwordHash = await createPasswordHash(password);
  const session = await prepareSession(env, userId);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, name, email, password_hash)
         VALUES (?, ?, ?, ?)`
      ).bind(userId, email, email, passwordHash),
      session.statement
    ]);
    return json({
      ok: true,
      message: "Conta criada com sucesso",
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: userId, email }
    }, 201);
  } catch (error) {
    console.error("Erro no cadastro:", error);
    return json({ error: "Não foi possível criar a conta. Verifique se o e-mail já existe." }, 409);
  }
}

async function login(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Dados inválidos" }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password || password.length > 128) return json({ error: "Informe e-mail e senha" }, 400);

  const user = await env.DB.prepare(
    `SELECT id, email, password_hash FROM users WHERE email = ?`
  ).bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) return json({ error: "E-mail ou senha incorretos" }, 401);

  const session = await prepareSession(env, user.id);
  await session.statement.run();
  return json({
    ok: true,
    message: "Login realizado com sucesso",
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, email: user.email }
  });
}

async function accountDetails(request, env) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: "Sessão inválida ou expirada" }, 401);
  return json({
    ok: true,
    user: { id: user.id, email: user.email },
    expiresAt: user.expires_at,
    lifetimeAccess: await hasLifetimeAccess(env, user.id)
  });
}

async function logout(request, env) {
  const token = getBearerToken(request);
  if (!token) return json({ error: "Sessão não encontrada" }, 401);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true, message: "Sessão encerrada" });
}

async function catalog(request, env, url) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: "Entre na sua conta para acessar a biblioteca" }, 401);
  const lifetimeAccess = await hasLifetimeAccess(env, user.id);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 1000), 1), 1000);
  const cursor = url.searchParams.get("cursor") || undefined;
  const pageOptions = { limit };
  if (cursor) pageOptions.cursor = cursor;
  const result = await env.MUSIC_BUCKET.list(pageOptions);
  const ticket = lifetimeAccess && env.MEDIA_SIGNING_SECRET
    ? await createMediaTicket(env, { scope: "premium", userId: user.id, sessionId: user.session_id })
    : null;

  const songs = (result.objects || []).filter(object => AUDIO_EXTENSION.test(object.key)).map(object => {
    const fileName = object.key.split("/").pop();
    const title = fileName.replace(/\.[^.]+$/, "").replace(/^\d+\s*-\s*/, "").trim();
    const encodedPath = encodeObjectKey(object.key);
    const audioUrl = `${url.origin}/stream/${encodedPath}`;
    const canStream = Boolean(ticket && lifetimeAccess);
    return {
      key: object.key,
      title,
      artist: "Mundo Musical",
      genre: folderFromKey(object.key),
      folder: folderFromKey(object.key),
      audioUrl,
      streamUrl: canStream ? `${audioUrl}?ticket=${encodeURIComponent(ticket)}` : ""
    };
  });

  return json({
    songs,
    nextCursor: result.truncated ? result.cursor : null,
    count: songs.length,
    access: {
      authenticated: true,
      userId: user.id,
      lifetimeAccess,
      streamingConfigured: Boolean(env.MEDIA_SIGNING_SECRET)
    }
  });
}

async function streamAuthorized(request, env, url) {
  const key = parseObjectKey(url.pathname);
  if (!key || !AUDIO_EXTENSION.test(key)) return json({ error: "Faixa não encontrada" }, 404);
  const ticket = url.searchParams.get("ticket") || "";
  const claims = await verifyMediaTicket(env, ticket);
  if (!claims) return json({ error: "Autorização de mídia inválida ou expirada" }, 401);
  if (claims.scope !== "premium" || !claims.sid || !claims.sub) {
    return json({ error: "Acesso vitalício necessário" }, 403);
  }
  if (!(await sessionIsActive(env, claims.sid, claims.sub))) {
    return json({ error: "Sessão encerrada ou expirada" }, 401);
  }
  if (!(await hasLifetimeAccess(env, claims.sub))) return json({ error: "Acesso vitalício não encontrado" }, 403);

  return streamR2(request, env, key);
}

function parseSignatureParts(value) {
  const parts = new Map();
  for (const item of String(value || "").split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const partValue = item.slice(separator + 1).trim();
    if (key && partValue) parts.set(key, partValue);
  }
  return parts;
}

export async function verifyWebhookSignature(xSignature, xRequestId, dataId, secret) {
  try {
    if (!xSignature || !secret) return false;
    const signatureParts = parseSignatureParts(xSignature);
    const timestamp = signatureParts.get("ts");
    const suppliedHash = signatureParts.get("v1");
    if (!timestamp || !suppliedHash) return false;
    const manifestParts = [];
    if (dataId) manifestParts.push(`id:${dataId};`);
    if (xRequestId) manifestParts.push(`request-id:${xRequestId};`);
    manifestParts.push(`ts:${timestamp};`);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(manifestParts.join("")));
    const calculatedHash = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
    return safeEqual(calculatedHash, suppliedHash);
  } catch {
    return false;
  }
}

async function checkout(request, env) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: "Entre na sua conta para continuar" }, 401);
  if (await hasLifetimeAccess(env, user.id)) return json({ ok: true, lifetimeAccess: true });
  if (!env.MERCADOPAGO_ACCESS_TOKEN || !env.MERCADOPAGO_WEBHOOK_SECRET) {
    return json({ error: "O pagamento ainda não está configurado. Tente novamente mais tarde." }, 503);
  }

  const orderId = crypto.randomUUID();
  let response;
  try {
    response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": orderId
      },
      body: JSON.stringify({
        items: [{
          id: "music-vip-lifetime",
          title: "MUSIC VIP — Acesso vitalício",
          quantity: 1,
          currency_id: "BRL",
          unit_price: PREMIUM_AMOUNT_CENTS / 100
        }],
        payer: { email: user.email },
        external_reference: orderId,
        metadata: { user_id: user.id, order_id: orderId, access_plan: "lifetime" },
        notification_url: `${new URL(request.url).origin}/payments/webhook`,
        back_urls: {
          success: `${SITE_URL}?mp_return=success`,
          pending: `${SITE_URL}?mp_return=pending`,
          failure: `${SITE_URL}?mp_return=failure`
        },
        auto_return: "approved",
        statement_descriptor: "MUSIC VIP"
      })
    });
  } catch (error) {
    console.error("Falha ao criar preferência Mercado Pago:", error);
    return json({ error: "Não foi possível iniciar o pagamento. Tente novamente." }, 502);
  }

  const preference = await response.json().catch(() => ({}));
  if (!response.ok || !preference.id || !preference.init_point) {
    console.error("Mercado Pago não criou a preferência:", response.status);
    return json({ error: "O Mercado Pago não conseguiu iniciar o pagamento." }, 502);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO checkout_orders
        (id, user_id, provider, preference_id, amount_cents, currency_id, status)
       VALUES (?, ?, 'mercadopago', ?, ?, 'BRL', 'pending')`
    ).bind(orderId, user.id, String(preference.id), PREMIUM_AMOUNT_CENTS).run();
  } catch (error) {
    console.error("Falha ao registrar preferência no D1:", error);
    return json({ error: "Não foi possível registrar o pagamento. Tente novamente." }, 500);
  }

  return json({ ok: true, checkoutUrl: preference.init_point, preferenceId: String(preference.id) }, 201);
}

async function paymentStatus(request, env) {
  const user = await authenticate(request, env);
  if (!user) return json({ error: "Sessão inválida ou expirada" }, 401);
  await reconcilePendingPayments(env, user.id);
  const latestOrder = await env.DB.prepare(
    `SELECT status, created_at FROM checkout_orders
     WHERE user_id = ? AND provider = 'mercadopago'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(user.id).first();
  return json({
    ok: true,
    lifetimeAccess: await hasLifetimeAccess(env, user.id),
    paymentStatus: latestOrder ? latestOrder.status : null,
    lastCheckoutAt: latestOrder ? latestOrder.created_at : null
  });
}

async function persistPayment(env, order, payment) {
  const providerPaymentId = String(payment.id);
  const paymentRowId = `mercadopago_${providerPaymentId}`;
  const amountCents = Math.round(Number(payment.transaction_amount) * 100);
  const status = String(payment.status || "unknown");
  const paidAt = payment.date_approved || null;
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT id, user_id, provider FROM payments WHERE provider_payment_id = ? LIMIT 1`
  ).bind(providerPaymentId).first();
  if (existing && (existing.provider !== "mercadopago" || existing.user_id !== order.user_id)) {
    return false;
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO payments
        (id, user_id, subscription_id, provider, provider_payment_id, amount_cents, status, paid_at)
       VALUES (?, ?, NULL, 'mercadopago', ?, ?, ?, ?)
       ON CONFLICT(provider_payment_id) DO UPDATE SET
         amount_cents = excluded.amount_cents,
         status = excluded.status,
         paid_at = excluded.paid_at
       WHERE payments.provider = 'mercadopago' AND payments.user_id = excluded.user_id`
    ).bind(paymentRowId, order.user_id, providerPaymentId, amountCents, status, paidAt),
    env.DB.prepare(
      `UPDATE checkout_orders
       SET status = ?, provider_payment_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(status, providerPaymentId, now, order.id, order.user_id)
  ];

  if (status === "approved") {
    statements.push(env.DB.prepare(
      `INSERT INTO user_entitlements
        (id, user_id, plan, status, source, payment_id, started_at, updated_at)
       VALUES (?, ?, 'lifetime', 'active', 'mercadopago', ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = 'lifetime', status = 'active', source = 'mercadopago',
         payment_id = excluded.payment_id, updated_at = excluded.updated_at`
    ).bind(`lifetime_${order.user_id}`, order.user_id, paymentRowId, paidAt || now, now));
  } else if (["refunded", "charged_back", "cancelled"].includes(status)) {
    statements.push(env.DB.prepare(
      `UPDATE user_entitlements SET status = 'inactive', updated_at = ?
       WHERE user_id = ? AND payment_id = ? AND source = 'mercadopago'`
    ).bind(now, order.user_id, paymentRowId));
  }

  await env.DB.batch(statements);
  return true;
}

async function verifyPaymentPreference(env, order, preferenceId) {
  const id = String(preferenceId || "");
  if (!id || id.length > 128) return { failure: "invalid_id" };

  let response;
  try {
    response = await fetch(`https://api.mercadopago.com/checkout/preferences/${encodeURIComponent(id)}`, {
      headers: {
        "Authorization": `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        "Accept": "application/json"
      }
    });
  } catch {
    return { failure: "network" };
  }
  if (!response.ok) return { failure: "http" };

  const preference = await response.json().catch(() => null);
  if (!preference || typeof preference !== "object") return { failure: "invalid_response" };
  const items = Array.isArray(preference.items) ? preference.items : [];
  const item = items.length === 1 ? items[0] || {} : {};
  const checks = {
    id: String(preference.id || "") === id,
    externalReference: String(preference.external_reference || "") === String(order.id),
    item: items.length === 1 &&
      String(item.id || "") === "music-vip-lifetime" &&
      Number(item.quantity) === 1 &&
      Math.round(Number(item.unit_price) * 100) === Number(order.amount_cents) &&
      String(item.currency_id || "") === String(order.currency_id || "BRL")
  };
  return { checks, valid: Object.values(checks).every(Boolean) };
}

async function persistApprovedReconciledPayment(env, order, payment, verifiedPreferenceId = null) {
  const providerPaymentId = String(payment.id);
  const paymentRowId = `mercadopago_${providerPaymentId}`;
  const amountCents = Math.round(Number(payment.transaction_amount) * 100);
  const paidAt = payment.date_approved || new Date().toISOString();
  const now = new Date().toISOString();
  const currentPreferenceId = String(order.preference_id || "");
  const targetPreferenceId = verifiedPreferenceId
    ? String(verifiedPreferenceId)
    : currentPreferenceId;
  if (!targetPreferenceId) return false;
  const existing = await env.DB.prepare(
    `SELECT id, user_id, provider FROM payments WHERE provider_payment_id = ? LIMIT 1`
  ).bind(providerPaymentId).first();
  if (existing && (existing.provider !== "mercadopago" || existing.user_id !== order.user_id)) return false;

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE checkout_orders
       SET status = 'approved', provider_payment_id = ?, updated_at = ?, preference_id = ?
       WHERE id = ? AND user_id = ? AND provider = 'mercadopago'
         AND (status = 'pending' OR (status = 'approved' AND provider_payment_id = ?))
         AND (provider_payment_id IS NULL OR provider_payment_id = ?)
         AND preference_id = ?`
    ).bind(providerPaymentId, now, targetPreferenceId, order.id, order.user_id, providerPaymentId, providerPaymentId, currentPreferenceId),
    env.DB.prepare(
      `INSERT INTO payments
        (id, user_id, subscription_id, provider, provider_payment_id, amount_cents, status, paid_at)
       SELECT ?, ?, NULL, 'mercadopago', ?, ?, 'approved', ?
       WHERE EXISTS (
         SELECT 1 FROM checkout_orders
         WHERE id = ? AND user_id = ? AND provider = 'mercadopago'
           AND status = 'approved' AND provider_payment_id = ?
       )
       ON CONFLICT(provider_payment_id) DO UPDATE SET
         amount_cents = excluded.amount_cents,
         status = excluded.status,
         paid_at = excluded.paid_at
       WHERE payments.provider = 'mercadopago' AND payments.user_id = excluded.user_id`
    ).bind(paymentRowId, order.user_id, providerPaymentId, amountCents, paidAt, order.id, order.user_id, providerPaymentId),
    env.DB.prepare(
      `INSERT INTO user_entitlements
        (id, user_id, plan, status, source, payment_id, started_at, updated_at)
       SELECT ?, ?, 'lifetime', 'active', 'mercadopago', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM checkout_orders AS orders
         JOIN payments ON payments.provider_payment_id = orders.provider_payment_id
         WHERE orders.id = ? AND orders.user_id = ? AND orders.provider = 'mercadopago'
           AND orders.status = 'approved' AND orders.provider_payment_id = ?
           AND payments.provider = 'mercadopago' AND payments.status = 'approved'
           AND payments.user_id = orders.user_id
       )
       ON CONFLICT(user_id) DO UPDATE SET
         plan = 'lifetime', status = 'active', source = 'mercadopago',
         payment_id = excluded.payment_id, updated_at = excluded.updated_at`
    ).bind(`lifetime_${order.user_id}`, order.user_id, paymentRowId, paidAt, now, order.id, order.user_id, providerPaymentId)
  ]);
  return Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) > 0;
}

async function reconcilePendingPayments(env, userId) {
  if (!env.MERCADOPAGO_ACCESS_TOKEN || !userId) return;
  let pendingOrders;
  try {
    pendingOrders = await env.DB.prepare(
      `SELECT id, user_id, preference_id, amount_cents, currency_id, status, last_reconciled_at
       FROM checkout_orders
       WHERE user_id = ? AND provider = 'mercadopago' AND status = 'pending'
       ORDER BY created_at DESC LIMIT ?`
    ).bind(userId, PAYMENT_RECONCILE_ORDER_LIMIT).all();
  } catch {
    console.error("Não foi possível carregar pedidos pendentes para reconciliação.");
    return;
  }

  const orders = Array.isArray(pendingOrders && pendingOrders.results) ? pendingOrders.results : [];
  for (const order of orders) {
    try {
      const now = Date.now();
      const checkedAt = new Date(now).toISOString();
      const cutoff = new Date(now - PAYMENT_RECONCILE_INTERVAL_MS).toISOString();
      const claim = await env.DB.prepare(
        `UPDATE checkout_orders SET last_reconciled_at = ?
         WHERE id = ? AND user_id = ? AND provider = 'mercadopago' AND status = 'pending'
           AND (last_reconciled_at IS NULL OR last_reconciled_at <= ?)`
      ).bind(checkedAt, order.id, userId, cutoff).run();
      if (Number(claim && claim.meta && claim.meta.changes || 0) !== 1) continue;

      const searchUrl = new URL("https://api.mercadopago.com/v1/payments/search");
      searchUrl.search = new URLSearchParams({
        external_reference: String(order.id),
        status: "approved",
        sort: "date_created",
        criteria: "desc",
        range: "date_created",
        begin_date: "NOW-30DAYS",
        end_date: "NOW",
        limit: String(PAYMENT_RECONCILE_PAYMENT_LIMIT)
      }).toString();
      const headers = {
        "Authorization": `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        "Accept": "application/json"
      };
      const searchResponse = await fetch(searchUrl, { headers });
      if (!searchResponse.ok) {
        console.error("Busca de reconciliação no Mercado Pago falhou:", searchResponse.status);
        continue;
      }
      const searchData = await searchResponse.json().catch(() => null);
      const resultPages = Array.isArray(searchData) ? searchData : [searchData];
      const searchResults = resultPages.flatMap(page =>
        Array.isArray(page && page.results) ? page.results : []
      );
      const candidates = searchResults.slice(0, PAYMENT_RECONCILE_PAYMENT_LIMIT);
      const summary = {
        searchShape: Array.isArray(searchData) ? "array" : searchData === null ? "null" : typeof searchData,
        pageCount: resultPages.length,
        resultCount: searchResults.length,
        candidateCount: candidates.length,
        invalidCandidateIds: 0,
        detailNetworkErrors: 0,
        detailHttpErrors: 0,
        invalidDetails: 0,
        detailsFetched: 0,
        mismatches: { status: 0, liveMode: 0, externalReference: 0, preference: 0, amount: 0, currency: 0 },
        preferenceVerification: {
          attempts: 0,
          networkErrors: 0,
          httpErrors: 0,
          invalidResponses: 0,
          idMismatches: 0,
          externalReferenceMismatches: 0,
          itemMismatches: 0,
          verified: 0
        },
        validatedPayments: 0,
        entitlementsGranted: 0
      };

      for (const candidate of candidates) {
        const candidateId = String(candidate && candidate.id || "");
        if (!candidateId || candidateId.length > 64) {
          summary.invalidCandidateIds++;
          continue;
        }
        let detailResponse;
        try {
          detailResponse = await fetch(
            `https://api.mercadopago.com/v1/payments/${encodeURIComponent(candidateId)}`,
            { headers }
          );
        } catch {
          summary.detailNetworkErrors++;
          continue;
        }
        if (!detailResponse.ok) {
          summary.detailHttpErrors++;
          continue;
        }
        const payment = await detailResponse.json().catch(() => null);
        if (!payment || String(payment.id) !== candidateId) {
          summary.invalidDetails++;
          continue;
        }
        summary.detailsFetched++;
        const storedPreferenceMatches = String(payment.preference_id || "") === String(order.preference_id || "");
        const checks = {
          status: payment.status === "approved",
          liveMode: payment.live_mode === true,
          externalReference: String(payment.external_reference || "") === String(order.id),
          preference: storedPreferenceMatches,
          amount: Math.round(Number(payment.transaction_amount) * 100) === Number(order.amount_cents),
          currency: String(payment.currency_id || "") === String(order.currency_id || "BRL")
        };
        if (!storedPreferenceMatches) summary.mismatches.preference++;

        let verifiedPreferenceId = null;
        const otherChecksMatch = Object.entries(checks)
          .every(([key, valid]) => key === "preference" || valid);
        if (!checks.preference && payment.preference_id && otherChecksMatch) {
          summary.preferenceVerification.attempts++;
          const verification = await verifyPaymentPreference(env, order, payment.preference_id);
          if (verification.failure === "network") summary.preferenceVerification.networkErrors++;
          else if (verification.failure === "http") summary.preferenceVerification.httpErrors++;
          else if (verification.failure) summary.preferenceVerification.invalidResponses++;
          else {
            if (!verification.checks.id) summary.preferenceVerification.idMismatches++;
            if (!verification.checks.externalReference) summary.preferenceVerification.externalReferenceMismatches++;
            if (!verification.checks.item) summary.preferenceVerification.itemMismatches++;
            if (verification.valid) {
              verifiedPreferenceId = String(payment.preference_id);
              checks.preference = true;
              summary.preferenceVerification.verified++;
            }
          }
        }

        for (const [key, valid] of Object.entries(checks)) {
          if (key === "preference") continue;
          if (!valid) summary.mismatches[key]++;
        }
        if (!Object.values(checks).every(Boolean)) continue;
        summary.validatedPayments++;
        if (await persistApprovedReconciledPayment(env, order, payment, verifiedPreferenceId)) {
          summary.entitlementsGranted++;
          break;
        }
      }
      console.info("MUSIC_PAYMENT_RECONCILIATION", summary);
    } catch {
      console.error("Não foi possível reconciliar um pedido pendente com o Mercado Pago.");
    }
  }
}

async function paymentWebhook(request, env, url) {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  let notification = {};
  try { notification = await request.clone().json(); }
  catch { return json({ error: "Notificação inválida" }, 400); }

  const type = url.searchParams.get("type") || notification.type || notification.topic || "";
  if (type && !["payment", "payments"].includes(String(type).toLowerCase())) return json({ ok: true, ignored: true });
  const dataIdFromUrl = url.searchParams.get("data.id") || url.searchParams.get("data_id") || "";
  const dataId = dataIdFromUrl || String(notification.data && notification.data.id || "");
  if (!dataId) return json({ error: "Identificador do pagamento ausente" }, 400);
  if (!env.MERCADOPAGO_WEBHOOK_SECRET || !(await verifyWebhookSignature(
    request.headers.get("x-signature"),
    request.headers.get("x-request-id"),
    dataIdFromUrl || dataId,
    env.MERCADOPAGO_WEBHOOK_SECRET
  ))) {
    return json({ error: "Assinatura de Webhook inválida" }, 401);
  }
  if (!env.MERCADOPAGO_ACCESS_TOKEN) return json({ error: "Mercado Pago não configurado" }, 503);

  let paymentResponse;
  try {
    paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(dataId)}`, {
      headers: { "Authorization": `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` }
    });
  } catch (error) {
    console.error("Falha ao consultar pagamento Mercado Pago:", error);
    return json({ error: "Não foi possível consultar o pagamento" }, 503);
  }
  if (!paymentResponse.ok) {
    if (paymentResponse.status === 404) return json({ ok: true, ignored: true });
    console.error("Consulta de pagamento Mercado Pago falhou:", paymentResponse.status);
    return json({ error: "Não foi possível consultar o pagamento" }, 503);
  }
  const payment = await paymentResponse.json().catch(() => null);
  if (!payment || String(payment.id) !== dataId) return json({ error: "Resposta de pagamento inválida" }, 502);

  const externalReference = String(payment.external_reference || "");
  let order = externalReference ? await env.DB.prepare(
    `SELECT id, user_id, preference_id, amount_cents, currency_id, status
     FROM checkout_orders WHERE id = ? AND provider = 'mercadopago' LIMIT 1`
  ).bind(externalReference).first() : null;
  if (!order && payment.preference_id) {
    order = await env.DB.prepare(
      `SELECT id, user_id, preference_id, amount_cents, currency_id, status
       FROM checkout_orders WHERE preference_id = ? AND provider = 'mercadopago' LIMIT 1`
    ).bind(String(payment.preference_id)).first();
  }
  if (!order) return json({ ok: true, ignored: true });

  const preferenceMatches = String(payment.preference_id || "") === String(order.preference_id);
  const referenceMatches = !externalReference || externalReference === order.id;
  const amountMatches = Math.round(Number(payment.transaction_amount) * 100) === Number(order.amount_cents);
  const currencyMatches = String(payment.currency_id || "") === String(order.currency_id || "BRL");
  if (!preferenceMatches || !referenceMatches || !amountMatches || !currencyMatches) {
    console.warn("Pagamento recebido não corresponde aos dados do checkout", { paymentId: dataId, orderId: order.id });
    return json({ ok: true, ignored: true });
  }

  const persisted = await persistPayment(env, order, payment);
  if (!persisted) return json({ ok: true, ignored: true });
  return json({ ok: true });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (!["GET", "POST", "HEAD"].includes(request.method)) return json({ error: "Método não permitido" }, 405);
  if (path === "/health" && request.method === "GET") {
    return json({
      ok: true,
      streamingConfigured: Boolean(env.MEDIA_SIGNING_SECRET),
      paymentsConfigured: Boolean(env.MERCADOPAGO_ACCESS_TOKEN && env.MERCADOPAGO_WEBHOOK_SECRET)
    });
  }
  if (!env.DB || !env.MUSIC_BUCKET) return json({ error: "Configuração do servidor incompleta" }, 500);

  if (path === "/auth/register") return request.method === "POST" ? registerAccount(request, env) : json({ error: "Use POST" }, 405);
  if (path === "/auth/login") return request.method === "POST" ? login(request, env) : json({ error: "Use POST" }, 405);
  if (path === "/auth/me") return request.method === "GET" ? accountDetails(request, env) : json({ error: "Use GET" }, 405);
  if (path === "/auth/logout") return request.method === "POST" ? logout(request, env) : json({ error: "Use POST" }, 405);
  if (path === "/catalog") return request.method === "GET" ? catalog(request, env, url) : json({ error: "Use GET" }, 405);
  if (path.startsWith("/stream/") && ["GET", "HEAD"].includes(request.method)) return streamAuthorized(request, env, url);
  if (path === "/payments/checkout") return request.method === "POST" ? checkout(request, env) : json({ error: "Use POST" }, 405);
  if (path === "/payments/status") return request.method === "GET" ? paymentStatus(request, env) : json({ error: "Use GET" }, 405);
  if (path === "/payments/webhook") return paymentWebhook(request, env, url);
  return json({ error: "Rota não encontrada" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("Erro no Worker MUSIC:", error);
      return json({ error: "Erro interno do servidor" }, 500);
    }
  }
};
