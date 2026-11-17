import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withAudit, type Database } from './audit';
import {
	EditError,
	issuesToFields,
	ReleaseFields,
	RecordingForm,
	type EditCtx
} from './catalog-edit';
import { credits, labels, parties, recordings, releases, releaseTracks } from './db/schema';
import { deriveReleaseType, type PlannedRecording } from './import/symphonic';
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
			.returning();
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
			const parsedRecording = RecordingForm.safeParse(input);
			if (!parsedRecording.success) throw new EditError(issuesToFields(parsedRecording.error));
			const { duration, ...fields } = parsedRecording.data;
			if (limits) {
				await lockLimit(tx, ctx.orgId, 'tracks');
				if ((await countRecordings(tx, ctx.orgId)) >= limits.tracks)
					throw new EditError({ form: LIMIT_MESSAGES.tracks(limits.tracks) });
			}
			const [clash] = await tx
				.select()
				.from(recordings)
				.where(and(eq(recordings.orgId, ctx.orgId), eq(recordings.isrc, fields.isrc)));
			if (clash)
				throw new EditError({ isrc: 'ISRC already exists; choose the existing recording' });
			[recording] = await tx
				.insert(recordings)
				.values({ ...fields, durationMs: duration, orgId: ctx.orgId })
				.returning();
			await audit({
				entity: 'recording',
				entityId: recording.id,
				action: 'create',
				after: recording
			});
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
