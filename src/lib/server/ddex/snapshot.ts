import { sql } from 'drizzle-orm';
import type { Database } from '#lib/server/audit.js';
import type { ErnSnapshot } from './ern';

/** One statement gives one consistent RLS snapshot, without changing locals.db's transaction. */
export async function ernSnapshot(
	tx: Database,
	orgId: string,
	releaseId: string
): Promise<ErnSnapshot | null> {
	const rows = await tx.execute(sql`
		with target as (
			select r.* from releases r where r.org_id = ${orgId}::uuid and r.id = ${releaseId}::uuid
		), placements as (
			select t.* from release_tracks t join target r on r.org_id=t.org_id and r.id=t.release_id
		), resources as (
			select distinct s.* from recordings s join placements t on t.org_id=s.org_id and t.recording_id=s.id
		), credit_rows as (
			select c.* from credits c join target r on r.org_id=c.org_id
			where c.release_id=r.id or c.recording_id in (select id from resources)
		), links as (
			select l.* from recording_compositions l join resources s on l.org_id=s.org_id and l.recording_id=s.id
		), work_rows as (
			select distinct w.* from compositions w join links l on l.org_id=w.org_id and l.composition_id=w.id
		), writer_rows as (
			select w.* from composition_writers w join work_rows c on c.org_id=w.org_id and c.id=w.composition_id
		), share_rows as (
			select s.* from rights_shares s join target r on r.org_id=s.org_id
			where s.recording_id in (select id from resources) or s.composition_id in (select id from work_rows)
		), party_rows as (
			select p.* from parties p join target r on r.org_id=p.org_id
			where p.id in (select party_id from credit_rows union select party_id from writer_rows union select holder_party_id from share_rows)
		)
		select jsonb_build_object(
			'orgId', r.org_id,
			'release', jsonb_build_object('id',r.id,'orgId',r.org_id,'labelId',r.label_id,'upc',r.upc,'catalogNumber',r.catalog_number,'title',r.title,'versionTitle',r.version_title,'type',r.type,'releaseDate',r.release_date,'genre',r.genre,'subgenre',r.subgenre),
			'label', jsonb_build_object('id',l.id,'orgId',l.org_id,'name',l.name),
			'tracks', coalesce((select jsonb_agg(jsonb_build_object('orgId',t.org_id,'releaseId',t.release_id,'recordingId',t.recording_id,'disc',t.disc,'position',t.position) order by t.disc,t.position) from placements t),'[]'::jsonb),
			'recordings', coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'orgId',s.org_id,'isrc',s.isrc,'title',s.title,'versionTitle',s.version_title,'durationMs',s.duration_ms,'genre',s.genre,'subgenre',s.subgenre) order by s.id) from resources s),'[]'::jsonb),
			'credits', coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'orgId',c.org_id,'releaseId',c.release_id,'recordingId',c.recording_id,'partyId',c.party_id,'role',c.role,'position',c.position,'approvedAt',c.approved_at) order by c.position,c.id) from credit_rows c),'[]'::jsonb),
			'parties', coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'orgId',p.org_id,'displayName',p.display_name) order by p.id) from party_rows p),'[]'::jsonb),
			'workLinks', coalesce((select jsonb_agg(jsonb_build_object('orgId',x.org_id,'recordingId',x.recording_id,'compositionId',x.composition_id) order by x.recording_id,x.composition_id) from links x),'[]'::jsonb),
			'works', coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'orgId',w.org_id,'iswc',w.iswc) order by w.id) from work_rows w),'[]'::jsonb),
			'writers', coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'orgId',w.org_id,'compositionId',w.composition_id,'partyId',w.party_id,'role',w.role,'share',w.share::text) order by w.id) from writer_rows w),'[]'::jsonb),
			'rights', coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'orgId',s.org_id,'territory',s.territory,'recordingId',s.recording_id,'compositionId',s.composition_id) order by s.id) from share_rows s),'[]'::jsonb)
		) as snapshot
		from target r join labels l on l.org_id=r.org_id and l.id=r.label_id
	`);
	// Durable ERN facts absent from today's schema are deliberately not supplied here.
	// The pure generator's fixtures can describe future complete snapshots; production preflight
	// reports the gaps until the separately scoped catalogue work supplies those facts.
	return (rows as unknown as { snapshot: ErnSnapshot }[])[0]?.snapshot ?? null;
}
