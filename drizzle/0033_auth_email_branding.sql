CREATE TABLE "org_auth_senders" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"resend_key_sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_auth_senders_domain_format" CHECK ("org_auth_senders"."domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);
--> statement-breakpoint
ALTER TABLE "org_auth_senders" ADD CONSTRAINT "org_auth_senders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_auth_senders_domain_key" ON "org_auth_senders" USING btree ("domain");--> statement-breakpoint
-- Auth email branded per label (EPSILON-146, knowledge labelkit 0035). A label's own sender domain
-- and its sealed Resend key must never be readable by a member, so, as for audiokit_label_clients
-- (0021), RLS is on with no policy and every grant Supabase's default privileges handed out is
-- taken away. Nothing writes the table yet: the settings page that does is a follow-up.
ALTER TABLE org_auth_senders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE org_auth_senders FROM PUBLIC, anon, authenticated, service_role, labelkit_app, labelkit_auth_email, labelkit_metrics_ingest;--> statement-breakpoint
-- The Send Email hook runs as labelkit_auth_email (0025, renamed in 0028), which has no table
-- rights. These two SECURITY DEFINER functions are all it gets in addition to member_org_ids(): the
-- branding of one org, found by the host the email links to (an active custom domain of an open
-- label) or, for an invite, by the inviting org's id. They return the org's id, its names, and its
-- own sender domain with the sealed key (which is useless without AUDIOKIT_CREDENTIALS_KEY), or no
-- row. No memberships, addresses or other orgs.
CREATE FUNCTION app_auth_email.org_brand_by_host(p_host text)
RETURNS TABLE (org_id uuid, name text, display_name text, sender_domain text, sender_key_sealed text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT o.id, o.name, o.display_name, s.domain, s.resend_key_sealed
 FROM public.orgs o
 LEFT JOIN public.org_auth_senders s ON s.org_id = o.id
 WHERE o.custom_domain = pg_catalog.lower(p_host)
   AND o.domain_status = 'active'
   AND o.closed_at IS NULL;
$$;--> statement-breakpoint
CREATE FUNCTION app_auth_email.org_brand_by_id(p_org uuid)
RETURNS TABLE (org_id uuid, name text, display_name text, sender_domain text, sender_key_sealed text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT o.id, o.name, o.display_name, s.domain, s.resend_key_sealed
 FROM public.orgs o
 LEFT JOIN public.org_auth_senders s ON s.org_id = o.id
 WHERE o.id = p_org
   AND o.closed_at IS NULL;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_auth_email.org_brand_by_host(text), app_auth_email.org_brand_by_id(uuid) FROM PUBLIC, anon, authenticated, service_role, labelkit_app, labelkit_metrics_ingest;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_auth_email.org_brand_by_host(text), app_auth_email.org_brand_by_id(uuid) TO labelkit_auth_email;
