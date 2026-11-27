-- Label sessions, step 2 (labelkit#258, knowledge labelkit 0051): the RLS pin.
--
-- A request on a label's own domain runs in a transaction pinned to that label: scoped.ts sets
-- app.pinned_org (step 1). From here the database honours it: while it is set, app.is_member and
-- app.has_role are false for every org other than the pinned one, so every policy that goes through
-- them stops seeing the person's other labels, whatever the route code does.
--
-- Nothing sets the pin yet, so behaviour is unchanged until step 3. An unset pin and an EMPTY one
-- (set_config leaves '' behind once a transaction-local setting has existed) both mean "no pin".
-- A value that is not a UUID raises instead of widening access.
--
-- Function-only change: CREATE OR REPLACE takes no table lock and keeps every grant. The policies
-- are untouched: none of them reads `memberships` directly (they call is_member / has_role /
-- can_catalog_create, which calls has_role). The functions that do read it directly are audited
-- below: authorize and complete_onboarding act for the caller in a given org, so they honour the
-- pin; the rest need not (see the PR for the list and why).

CREATE FUNCTION app.pinned_org() RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
	SELECT nullif(pg_catalog.current_setting('app.pinned_org', true), '')::uuid
$$;--> statement-breakpoint
-- Like app.current_user_id() it only reads a setting, so it keeps the default execute right; the
-- grant is for the app role, which the policies' own callers do not need (is_member is SECURITY
-- DEFINER) but a route may use.
GRANT EXECUTE ON FUNCTION app.pinned_org() TO labelkit_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_member(target_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
	SELECT EXISTS (
		SELECT 1 FROM memberships m
		WHERE m.org_id = target_org AND m.user_id = app.current_user_id()
			AND (app.pinned_org() IS NULL OR m.org_id = app.pinned_org())
	)
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.has_role(target_org uuid, roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
	SELECT EXISTS (
		SELECT 1 FROM memberships m
		WHERE m.org_id = target_org
			AND m.user_id = app.current_user_id()
			AND m.role::text = ANY (roles)
			AND (app.pinned_org() IS NULL OR m.org_id = app.pinned_org())
	)
$$;--> statement-breakpoint

-- Reads the caller's role in target_org (0010): the same condition, so a pinned session cannot ask
-- for a decision in another label.
CREATE OR REPLACE FUNCTION app.authorize(target_org uuid, target_recording uuid, wanted processing_purpose)
 RETURNS authorization_decisions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
	caller_role text;
	master_complete boolean;
	our_share numeric;
	consent_ids uuid[];
	main_artists uuid[];
	consenting uuid[];
	missing uuid[];
	reasons text[] := ARRAY[]::text[];
	decision authorization_decisions;
BEGIN
	SELECT m.role::text INTO caller_role FROM memberships m
	WHERE m.org_id = target_org AND m.user_id = app.current_user_id()
		AND (app.pinned_org() IS NULL OR m.org_id = app.pinned_org());
	IF caller_role IS NULL OR caller_role NOT IN ('owner', 'catalog_manager', 'agent') THEN
		RAISE EXCEPTION 'not allowed to request processing' USING ERRCODE = '42501';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM recordings WHERE id = target_recording AND org_id = target_org) THEN
		RAISE EXCEPTION 'recording not found' USING ERRCODE = 'P0002';
	END IF;

	SELECT EXISTS (
		SELECT 1 FROM rights_shares
		WHERE org_id = target_org AND recording_id = target_recording AND "right" = 'master' AND territory = 'WW'
	), coalesce((
		SELECT sum(share) FROM rights_shares
		WHERE org_id = target_org AND recording_id = target_recording AND "right" = 'master'
			AND territory = 'WW' AND holder_label_id IS NOT NULL
	), 0)
	INTO master_complete, our_share;

	SELECT coalesce(array_agg(DISTINCT c.party_id), ARRAY[]::uuid[]) INTO main_artists
	FROM credits c WHERE c.org_id = target_org AND c.recording_id = target_recording AND c.role = 'main';

	-- Active consents for this purpose: for this recording, or blanket consents from
	-- someone credited on it.
	SELECT coalesce(array_agg(k.id), ARRAY[]::uuid[]), coalesce(array_agg(DISTINCT k.party_id), ARRAY[]::uuid[])
	INTO consent_ids, consenting
	FROM consents k
	WHERE k.org_id = target_org AND k.purpose = wanted
		AND k.revoked_at IS NULL
		AND k.granted_on <= current_date
		AND (k.expires_on IS NULL OR k.expires_on >= current_date)
		AND (k.recording_id = target_recording OR (k.recording_id IS NULL AND EXISTS (
			SELECT 1 FROM credits c WHERE c.recording_id = target_recording AND c.party_id = k.party_id
		)));

	IF NOT master_complete THEN
		reasons := reasons || 'master_incomplete'::text;
	END IF;
	IF our_share = 0 THEN
		reasons := reasons || 'not_controlled'::text;
	END IF;

	missing := ARRAY(SELECT unnest(main_artists) EXCEPT SELECT unnest(consenting));
	IF wanted IN ('stem_separation', 'mastering') AND our_share < 100 AND cardinality(consent_ids) = 0 THEN
		reasons := reasons || 'consent_missing'::text;
	ELSIF wanted IN ('voice', 'generation') THEN
		IF cardinality(main_artists) = 0 THEN
			reasons := reasons || 'no_main_artist'::text;
		ELSIF cardinality(missing) > 0 THEN
			reasons := reasons || 'consent_missing'::text;
		END IF;
	END IF;

	INSERT INTO authorization_decisions
		(id, org_id, recording_id, purpose, allowed, reasons, basis, actor_id, actor_kind)
	VALUES (
		gen_random_uuid(), target_org, target_recording, wanted, cardinality(reasons) = 0,
		to_jsonb(reasons),
		jsonb_build_object(
			'master_complete', master_complete,
			'label_share', trim_scale(our_share),
			'consents', to_jsonb(consent_ids),
			'main_artists', to_jsonb(main_artists),
			'missing_consent', CASE WHEN wanted IN ('voice', 'generation') THEN to_jsonb(missing) ELSE '[]'::jsonb END
		),
		app.current_user_id()::text,
		CASE WHEN caller_role = 'agent' THEN 'agent'::actor_kind ELSE 'user'::actor_kind END
	)
	RETURNING * INTO decision;
	RETURN decision;
END $function$;
--> statement-breakpoint

-- Stamps the caller's own membership in target_org (0014): a pinned session may stamp only the
-- pinned label's.
CREATE OR REPLACE FUNCTION app.complete_onboarding(target_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
	UPDATE memberships SET onboarded_at = now()
	WHERE org_id = target_org AND user_id = app.current_user_id()
		AND (app.pinned_org() IS NULL OR org_id = app.pinned_org())
$$;
