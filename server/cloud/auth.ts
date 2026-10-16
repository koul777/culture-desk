import { createHash, timingSafeEqual } from 'node:crypto';
const digest = (value: string) => createHash('sha256').update(value).digest();
export function equalSecret(received: string, expected: string): boolean {
  return !!expected && timingSafeEqual(digest(received), digest(expected));
}
export function validMutationOrigin(request: Request): boolean {
  if (request.headers.get('x-culture-request') !== '1') return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
