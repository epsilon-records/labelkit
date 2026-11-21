ALTER TABLE "api_create_requests" ADD CONSTRAINT "api_create_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
