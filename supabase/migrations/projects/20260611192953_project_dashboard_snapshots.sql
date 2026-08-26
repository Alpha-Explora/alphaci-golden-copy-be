CREATE TABLE IF NOT EXISTS projects.project_dashboard_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warning', 'error')),
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_by UUID NULL REFERENCES identity.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_dashboard_snapshots_project_created
  ON projects.project_dashboard_snapshots (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_dashboard_snapshots_status
  ON projects.project_dashboard_snapshots (status);

COMMENT ON TABLE projects.project_dashboard_snapshots
  IS 'Cached local project control-center health snapshots. Values are derived from FlowCI stored state unless live provider adapters are explicitly enabled in a later phase.';
