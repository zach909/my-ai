/**
 * The two errors every desktop backend shares. They live in their own file so the backends can import them
 * without importing each other.
 */

export class DesktopError extends Error {}

/** This platform cannot do this, and says why. Different from a failure: retrying will not help. */
export class Unsupported extends DesktopError {}
