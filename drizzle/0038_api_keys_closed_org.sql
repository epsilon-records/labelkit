-- A closed label's API keys stop creating catalogue rows (the request hook already refuses the
-- keys themselves). Reopening the label restores access. Function-only change: no table is touched.
CREATE OR REPLACE FUNCTION app.can_catalog_create(target_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT app.has_role(target_org, ARRAY['agent']) AND EXISTS (
  SELECT 1 FROM api_keys WHERE org_id = target_org AND actor_id = app.current_user_id()
  AND revoked_at IS NULL AND 'catalog:write' = ANY(scopes)
 ) AND EXISTS (SELECT 1 FROM orgs WHERE id = target_org AND closed_at IS NULL)
$$;
