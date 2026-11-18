import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withAudit, type Database } from './audit';
import {
	ArtistForm,
	EditError,
	issuesToFields,
	ReleaseFields,
	RecordingForm,
	type EditCtx
} from './catalog-edit';
import { credits, labels, parties, recordings, releases, releaseTracks } from './db/schema';
import { deriveReleaseType, type PlannedRecording } from './import/symphonic';
import { partyMatchKey } from './import/identifiers';
import { countRecordings, LIMIT_MESSAGES, lockLimit, type PlanLimits } from './plans';

export async function createRelease(db: Database, ctx: EditCtx, input: Record<string, unknown>) {
	const parsed = ReleaseFields.safeParse(input);
	if (!parsed.success) throw new EditError(issuesToFields(parsed.error));
	return withAudit(db, ctx, async (tx, audit) => {
		const [label] = await tx
			.select()
			.from(labels)
			.where(and(eq(labels.orgId, ctx.orgId), eq(labels.id, parsed.data.labelId)));
		if (!label) throw new EditError({ labelId: 'Unknown label' });
		const [clash] = await tx
			.select()
			.from(releases)
			.where(and(eq(releases.orgId, ctx.orgId), eq(releases.upc, parsed.data.upc)));
		if (clash) throw new EditError({ upc: 'UPC already used by another release' });
		const [release] = await tx
			.insert(releases)
			.values({
				...parsed.data,
				orgId: ctx.orgId,
				type: deriveReleaseType({ artists: [], tracks: [] }, new Map())
			})
			.onConflictDoNothing({ target: [releases.orgId, releases.upc] })
			.returning();
		if (!release) throw new EditError({ upc: 'UPC already used by another release' });
		await audit({ entity: 'release', entityId: release.id, action: 'create', after: release });
		return release;
	});
}

const TrackPosition = z.object({
	disc: z.coerce.number().int().positive().max(2147483647),
	position: z.coerce.number().int().positive().max(2147483647),
	mode: z.enum(['existing', 'new'])
});

/** Lock the release before checking positions so concurrent adds cannot silently overwrite tracks. */
export async function addTrack(
	db: Database,
	ctx: EditCtx,
	releaseId: string,
	input: Record<string, unknown>,
	limits: PlanLimits | null = null
) {
	const parsed = TrackPosition.safeParse(input);
	if (!parsed.success) throw new EditError(issuesToFields(parsed.error));
	return withAudit(db, ctx, async (tx, audit) => {
		const [release] = await tx
			.select()
			.from(releases)
			.where(and(eq(releases.orgId, ctx.orgId), eq(releases.id, releaseId)))
			.for('update');
		if (!release) throw new EditError({ form: 'Release not found' });
		const { disc, position, mode } = parsed.data;
		const [occupied] = await tx
			.select()
			.from(releaseTracks)
			.where(
				and(
					eq(releaseTracks.releaseId, releaseId),
					eq(releaseTracks.disc, disc),
					eq(releaseTracks.position, position)
				)
			);
		if (occupied) throw new EditError({ position: 'That track position is already used' });
		let recording;
		if (mode === 'existing') {
			const id = z.uuid().safeParse(input.recordingId);
			if (!id.success) throw new EditError({ recordingId: 'Choose a recording' });
			[recording] = await tx
				.select()
				.from(recordings)
				.where(and(eq(recordings.orgId, ctx.orgId), eq(recordings.id, id.data)));
			if (!recording) throw new EditError({ recordingId: 'Recording not found' });
		} else {
			recording = await createRecording(tx, ctx, input, limits);
		}
		await tx
			.insert(releaseTracks)
			.values({ orgId: ctx.orgId, releaseId, recordingId: recording.id, disc, position });
		const rows = await tx
			.select({ recording: recordings, position: releaseTracks.position })
			.from(releaseTracks)
			.innerJoin(recordings, eq(recordings.id, releaseTracks.recordingId))
			.where(eq(releaseTracks.releaseId, releaseId));
		const artistRows = await tx
			.select({
				name: parties.displayName,
				role: credits.role,
				recordingId: credits.recordingId,
				releaseId: credits.releaseId,
				position: credits.position
			})
			.from(credits)
			.innerJoin(parties, eq(parties.id, credits.partyId))
			.where(eq(credits.orgId, ctx.orgId));
		const map = new Map<string, PlannedRecording>(
			rows.map(({ recording: r }) => [
				r.isrc,
				{ ...r, credits: artistRows.filter((c) => c.recordingId === r.id) }
			])
		);
		const type = deriveReleaseType(
			{
				artists: artistRows
					.filter((c) => c.releaseId === releaseId && c.role === 'main')
					.map((c) => c.name),
				tracks: rows.map((r) => ({ isrc: r.recording.isrc, position: r.position }))
			},
			map
		);
		await tx
			.update(releases)
			.set({ type, updatedAt: new Date() })
			.where(eq(releases.id, releaseId));
		await audit({
			entity: 'release',
			entityId: releaseId,
			action: 'add_track',
			before: { type: release.type },
			after: { type, recordingId: recording.id, disc, position }
		});
		return recording;
	});
}

export async function createArtist(db: Database, ctx: EditCtx, input: Record<string, unknown>) {
	const parsed = ArtistForm.safeParse(input);
	if (!parsed.success) throw new EditError(issuesToFields(parsed.error));
	const displayName = parsed.data.displayName.replace(/\s+/g, ' ');
	const matchKey = partyMatchKey(displayName);
	return withAudit(db, ctx, async (tx, audit) => {
		const [existing] = await tx
			.select()
			.from(parties)
			.where(and(eq(parties.orgId, ctx.orgId), eq(parties.matchKey, matchKey)));
		if (existing) throw new EditError({ displayName: 'An artist with this name already exists' });
		const [artist] = await tx
			.insert(parties)
			.values({ orgId: ctx.orgId, displayName, matchKey, kind: 'unknown' })
			.onConflictDoNothing({ target: [parties.orgId, parties.matchKey] })
			.returning();
		if (!artist) throw new EditError({ displayName: 'An artist with this name already exists' });
		await audit({ entity: 'party', entityId: artist.id, action: 'create', after: artist });
		return artist;
	});
}

export async function createRecording(
	db: Database,
	ctx: EditCtx,
	input: Record<string, unknown>,
	limits: PlanLimits | null = null
) {
	const parsed = RecordingForm.safeParse(input);
	if (!parsed.success) throw new EditError(issuesToFields(parsed.error));
	const { duration, ...fields } = parsed.data;
	return withAudit(db, ctx, async (tx, audit) => {
		if (limits) {
			await lockLimit(tx, ctx.orgId, 'tracks');
			if ((await countRecordings(tx, ctx.orgId)) >= limits.tracks)
				throw new EditError({ form: LIMIT_MESSAGES.tracks(limits.tracks) });
		}
		const [existing] = await tx
			.select()
			.from(recordings)
			.where(and(eq(recordings.orgId, ctx.orgId), eq(recordings.isrc, fields.isrc)));
		if (existing)
			throw new EditError({ isrc: 'ISRC already exists; choose the existing recording' });
		const [recording] = await tx
			.insert(recordings)
			.values({ ...fields, durationMs: duration, orgId: ctx.orgId })
			.onConflictDoNothing({ target: [recordings.orgId, recordings.isrc] })
			.returning();
		if (!recording)
			throw new EditError({ isrc: 'ISRC already exists; choose the existing recording' });
		await audit({
			entity: 'recording',
			entityId: recording.id,
			action: 'create',
			after: recording
		});
		return recording;
	});
}
