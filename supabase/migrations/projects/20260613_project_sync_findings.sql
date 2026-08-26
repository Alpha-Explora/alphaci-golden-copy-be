CREATE TABLE IF NOT EXISTS projects.project_sync_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  target_id UUID NULL REFERENCES env_provisioning.project_deployment_targets(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'local_snapshot',
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'ignored')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_sync_findings_project_status
  ON projects.project_sync_findings(project_id, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_sync_findings_target
  ON projects.project_sync_findings(target_id)
  WHERE target_id IS NOT NULL;
