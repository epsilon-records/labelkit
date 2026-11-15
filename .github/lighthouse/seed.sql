-- Test data for the signed-in Lighthouse run (.github/workflows/lighthouse.yml), applied as the
-- database owner on the throwaway CI database only. It gives the test user (created by session.mjs)
-- a label of their own and a small catalogue, so /releases renders a real list.
--
--   psql -v user_id=<the test user's id> -f seed.sql

\set ON_ERROR_STOP on

INSERT INTO orgs (id, name, slug)
VALUES ('01900000-0000-7000-8000-000000000501', 'Lighthouse label', 'lighthouse');

INSERT INTO labels (id, org_id, name)
VALUES ('01900000-0000-7000-8000-000000000502', '01900000-0000-7000-8000-000000000501', 'Lighthouse imprint');

-- An onboarded owner, so the request hook neither redirects to /onboarding nor to /signup/label.
INSERT INTO memberships (org_id, user_id, role, onboarded_at)
VALUES ('01900000-0000-7000-8000-000000000501', :'user_id', 'owner', now());

INSERT INTO recordings (id, org_id, isrc, title, duration_ms, genre) VALUES
  ('01900000-0000-7000-8000-000000000520', '01900000-0000-7000-8000-000000000501', 'QZFZZ2600501', 'First Track', 215000, 'Techno'),
  ('01900000-0000-7000-8000-000000000521', '01900000-0000-7000-8000-000000000501', 'QZFZZ2600502', 'Second Track', 402000, 'Techno');

INSERT INTO releases (id, org_id, label_id, upc, catalog_number, title, type, release_date, genre) VALUES
  ('01900000-0000-7000-8000-000000000530', '01900000-0000-7000-8000-000000000501', '01900000-0000-7000-8000-000000000502', '000000000501', 'LHC001', 'First Release', 'ep', '2026-01-09', 'Techno'),
  ('01900000-0000-7000-8000-000000000531', '01900000-0000-7000-8000-000000000501', '01900000-0000-7000-8000-000000000502', '000000000502', 'LHC002', 'Second Release', 'single', '2026-03-06', 'Techno');

INSERT INTO release_tracks (org_id, release_id, recording_id, disc, position) VALUES
  ('01900000-0000-7000-8000-000000000501', '01900000-0000-7000-8000-000000000530', '01900000-0000-7000-8000-000000000520', 1, 1),
  ('01900000-0000-7000-8000-000000000501', '01900000-0000-7000-8000-000000000531', '01900000-0000-7000-8000-000000000521', 1, 1);
