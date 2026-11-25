import raw from '../../../docs/openapi.yaml?raw';
import { apiReference } from '#lib/server/api-reference.js';

export const prerender = true;
export const load = () => ({ reference: apiReference(raw) });
