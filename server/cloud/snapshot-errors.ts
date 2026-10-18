/** Kept independent of the database adapter so published reads do not load PostgreSQL. */
export class SnapshotCapacityError extends Error {
  readonly code = 'SNAPSHOT_CAPACITY';
  constructor() { super('Cloud snapshot capacity exceeded'); this.name = 'SnapshotCapacityError'; }
}
