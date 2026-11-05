DROP INDEX IF EXISTS projects_name_unique_idx;

CREATE UNIQUE INDEX projects_owner_name_unique_idx
ON projects (owner_id, LOWER(name))
WHERE owner_id IS NOT NULL;