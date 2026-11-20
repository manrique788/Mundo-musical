ALTER TABLE checkout_orders ADD COLUMN last_reconciled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_checkout_orders_reconciliation
  ON checkout_orders (user_id, provider, status, last_reconciled_at, created_at DESC);
