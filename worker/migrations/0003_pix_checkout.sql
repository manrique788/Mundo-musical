CREATE TABLE IF NOT EXISTS pix_checkout_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'mercadopago'),
  provider_payment_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency_id TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'creating',
  qr_code TEXT,
  qr_code_base64 TEXT,
  ticket_url TEXT,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pix_checkout_orders_user_created
  ON pix_checkout_orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pix_checkout_orders_reconciliation
  ON pix_checkout_orders (user_id, provider, status, last_reconciled_at, created_at DESC);
