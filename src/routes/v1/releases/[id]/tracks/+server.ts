import { createEndpoint } from '#lib/server/api/create.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = createEndpoint('track');
