CREATE TABLE IF NOT EXISTS developer_api_key_rate_limits (
  key_id UUID PRIMARY KEY REFERENCES developer_api_keys(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON TABLE developer_api_key_rate_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE developer_api_key_rate_limits TO d_database_app;
