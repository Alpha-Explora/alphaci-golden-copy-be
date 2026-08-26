CREATE TABLE IF NOT EXISTS projects.project_workflow_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES identity.app_users(id) ON DELETE SET NULL,
  updated_by UUID NULL REFERENCES identity.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_workflow_settings_project_unique UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_workflow_settings_updated
  ON projects.project_workflow_settings (updated_at DESC);

COMMENT ON TABLE projects.project_workflow_settings
  IS 'Normalized workflow customization settings for preview and later PR-based workflow updates. Generated YAML is not stored as the source of truth.';
