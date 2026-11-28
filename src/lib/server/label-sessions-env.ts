import { LABEL_SESSIONS } from '$app/env/private';

/**
 * Whether sessions on a label's own domain are label-only (knowledge labelkit 0051, 0054,
 * epsilon-records/labelkit#258). Off by default. Read at call time, and kept in its own module so
 * tests can switch it.
 */
export const labelSessionsEnabled = (): boolean => LABEL_SESSIONS === true;
