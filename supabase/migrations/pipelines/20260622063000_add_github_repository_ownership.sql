ALTER TABLE github_app.github_installation_accounts
  ADD COLUMN IF NOT EXISTS account_type TEXT NULL;

ALTER TABLE github_app.github_installation_accounts
  DROP CONSTRAINT IF EXISTS github_installation_accounts_account_type_check;

ALTER TABLE github_app.github_installation_accounts
  ADD CONSTRAINT github_installation_accounts_account_type_check
  CHECK (account_type IS NULL OR account_type IN ('Organization', 'User'));

CREATE TABLE IF NOT EXISTS github_app.webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ NULL
);

ALTER TABLE github_app.webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON github_app.webhook_deliveries FROM anon, authenticated;
