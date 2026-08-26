CREATE TABLE IF NOT EXISTS projects.project_workflow_update_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  requested_by UUID NULL REFERENCES identity.app_users(id) ON DELETE SET NULL,
  branch_name TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  pull_request_number INTEGER NOT NULL,
  pull_request_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'failed')),
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_files_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_workflow_update_requests_project_created
  ON projects.project_workflow_update_requests (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_workflow_update_requests_status
  ON projects.project_workflow_update_requests (status);

COMMENT ON TABLE projects.project_workflow_update_requests
  IS 'Metadata for PR-based workflow settings updates. Direct apply is intentionally not supported.';
