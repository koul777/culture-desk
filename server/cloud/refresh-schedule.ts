import type { PublicRefreshStatus } from '../../shared/types.js';

/** Public schedule metadata does not require the database-backed job repository. */
export const REFRESH_SCHEDULE: PublicRefreshStatus['schedule'] = {
  timezone: 'Asia/Seoul', primary: '04:17', retries: ['06:47', '12:47', '20:47'],
};
