SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "api_create_requests" (
	"org_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX api_create_requests_pk_idx ON api_create_requests (org_id, actor_id, route, key);
--> statement-breakpoint
ALTER TABLE api_create_requests ADD CONSTRAINT api_create_requests_org_id_actor_id_route_key_pk PRIMARY KEY USING INDEX api_create_requests_pk_idx;
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_scopes_allowed";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_allowed" CHECK ("api_keys"."scopes" <@ ARRAY['catalog:read','catalog:write','processing:request']::text[] AND cardinality("api_keys"."scopes") > 0) NOT VALID;
--> statement-breakpoint
-- Actor identity comes from the authenticated key, never request JSON. Revocation closes access.
CREATE FUNCTION app.can_catalog_create(target_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT app.has_role(target_org, ARRAY['agent']) AND EXISTS (
  SELECT 1 FROM api_keys WHERE org_id = target_org AND actor_id = app.current_user_id()
  AND revoked_at IS NULL AND 'catalog:write' = ANY(scopes)
 )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.can_catalog_create(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_catalog_create(uuid) TO labelkit_app;
--> statement-breakpoint
ALTER TABLE api_create_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON api_create_requests FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON api_create_requests TO labelkit_app;
--> statement-breakpoint
CREATE POLICY api_create_receipts_select ON api_create_requests FOR SELECT TO labelkit_app
 USING (actor_id = app.current_user_id() AND app.can_catalog_create(org_id));
--> statement-breakpoint
CREATE POLICY api_create_receipts_insert ON api_create_requests FOR INSERT TO labelkit_app
 WITH CHECK (actor_id = app.current_user_id() AND app.can_catalog_create(org_id));
--> statement-breakpoint
CREATE POLICY parties_agent_create ON parties FOR INSERT TO labelkit_app WITH CHECK (app.can_catalog_create(org_id));
--> statement-breakpoint
CREATE POLICY recordings_agent_create ON recordings FOR INSERT TO labelkit_app WITH CHECK (app.can_catalog_create(org_id));
--> statement-breakpoint
CREATE POLICY releases_agent_create ON releases FOR INSERT TO labelkit_app WITH CHECK (app.can_catalog_create(org_id));
--> statement-breakpoint
CREATE POLICY tracks_agent_create ON release_tracks FOR INSERT TO labelkit_app WITH CHECK (app.can_catalog_create(org_id));
--> statement-breakpoint
-- Track insertion locks the parent and refreshes its derived type in the shared create module.
CREATE POLICY releases_agent_derive ON releases FOR UPDATE TO labelkit_app
 USING (app.can_catalog_create(org_id)) WITH CHECK (app.can_catalog_create(org_id));
--> statement-breakpoint
CREATE POLICY audit_agent_create ON audit_log FOR INSERT TO labelkit_app WITH CHECK (
 app.can_catalog_create(org_id) AND actor_kind = 'agent' AND actor_id = app.current_user_id()::text
);
--> statement-breakpoint
-- Agent keys need only the type refresh during track creation, never general release edits.
CREATE FUNCTION app.guard_agent_release_refresh() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF current_user = 'labelkit_app' AND app.has_role(OLD.org_id, ARRAY['agent']) THEN
  IF (to_jsonb(OLD) - 'type' - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'type' - 'updated_at') THEN
   RAISE EXCEPTION 'agent keys cannot edit release fields' USING ERRCODE = '42501';
  END IF;
 END IF;
 RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_agent_release_refresh() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER releases_agent_refresh_only BEFORE UPDATE ON releases
 FOR EACH ROW EXECUTE FUNCTION app.guard_agent_release_refresh();
