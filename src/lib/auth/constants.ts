/**
 * Authentication constants shared by the Node runtime (lib/auth/*) and the edge
 * middleware. Keep this file dependency-free: middleware.ts imports it and the
 * edge bundle must not pull in Prisma, argon2 or the env schema.
 */

/** httpOnly cookie carrying the staff session token (see lib/auth/session.ts). */
export const SESSION_COOKIE = "cm_session";

/** httpOnly cookie carrying a verified embed token for a framed surface. */
export const EMBED_COOKIE = "cm_embed";

/** Absolute lifetime of a staff session; after this the user signs in again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** `Session.lastSeenAt` is refreshed at most this often. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Lifetime of an invitation link. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Lifetime of a password-reset link. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Rate limits for the authentication endpoints (sliding window, per process). */
export const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
/** Sign-in attempts allowed per client IP per window. */
export const LOGIN_IP_LIMIT = 30;
/** Sign-in attempts allowed per e-mail address per window. */
export const LOGIN_EMAIL_LIMIT = 10;
/** Failed sign-ins (recorded in `LoginEvent`) before an account is locked for the window. */
export const LOGIN_LOCKOUT_FAILURES = 10;
/** Password-reset requests allowed per client IP per window. */
export const RESET_IP_LIMIT = 10;
/** Password-reset requests allowed per e-mail address per window. */
export const RESET_EMAIL_LIMIT = 3;
/** Set-password submissions allowed per client IP per window. */
export const SET_PASSWORD_IP_LIMIT = 10;
