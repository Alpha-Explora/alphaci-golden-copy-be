-- Remove the retired synthetic demo projects. These records were never real
-- GitHub repositories; they were placeholder rows shown in the product UI.
DELETE FROM projects.provisioned_projects
WHERE is_example = true
   OR LOWER(repo_full_name) IN (
     'flowci-demo-app',
     'flowci-demo/flowci-demo-app',
     'alpha-explora/flowci-demo-app',
     'alphaexplora/flowci-demo-app',
     'alphaci-demo/alphaci-demo-app'
   );
