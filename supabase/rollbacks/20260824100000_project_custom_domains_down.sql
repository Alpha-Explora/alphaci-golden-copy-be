-- Rollback for 20260824100000_project_custom_domains.sql
--
-- Drops the local record of which hostnames were attached. The domains
-- themselves live on the provider and are NOT removed here — running this does
-- not detach anything from Vercel or Render, it only forgets that this product
-- knew about them. Detach through the UI first if that is what you want.

DROP TRIGGER IF EXISTS trg_project_custom_domains_updated_at
  ON env_provisioning.project_custom_domains;

DROP TABLE IF EXISTS env_provisioning.project_custom_domains;
