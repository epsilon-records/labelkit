CREATE TABLE "label_handoffs" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"host" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "label_handoffs_ticket_hash_format" CHECK ("label_handoffs"."ticket_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "label_handoffs_host_format" CHECK ("label_handoffs"."host" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);
--> statement-breakpoint
CREATE TABLE "label_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"host" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "label_sessions_id_hash_format" CHECK ("label_sessions"."id_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "label_sessions_host_format" CHECK ("label_sessions"."host" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);
--> statement-breakpoint
ALTER TABLE "label_handoffs" ADD CONSTRAINT "label_handoffs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_sessions" ADD CONSTRAINT "label_sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_handoffs_expires_idx" ON "label_handoffs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "label_sessions_user_idx" ON "label_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "label_sessions_org_idx" ON "label_sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "label_sessions_host_idx" ON "label_sessions" USING btree ("host");--> statement-breakpoint
CREATE INDEX "label_sessions_expires_idx" ON "label_sessions" USING btree ("expires_at");--> statement-breakpoint
-- Label sessions and their handoff tickets (knowledge labelkit 0051, 0054). Only the hashes of the
-- cookie and the ticket are stored, but a row still names who may act for which label, so, as for
-- org_auth_senders (0033), RLS is on with no policy and every grant Supabase's default privileges
-- handed out is taken away. Only label-session.ts, on the owner connection, reads or writes them.
ALTER TABLE label_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE label_handoffs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE label_sessions, label_handoffs FROM PUBLIC, anon, authenticated, service_role, labelkit_app, labelkit_auth_email, labelkit_metrics_ingest;
