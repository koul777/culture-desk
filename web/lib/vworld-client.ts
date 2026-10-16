export interface VWorldMessage {
  type: 'culture-vworld'; channel: string; status: 'ready' | 'error'; message?: string;
}

/** A sibling frame or unrelated window must not be able to complete or fail this viewer. */
export function readVWorldMessage(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, frame: Window | null, origin: string, channel: string): VWorldMessage | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.type !== 'culture-vworld' || value.channel !== channel || (value.status !== 'ready' && value.status !== 'error')) return null;
  return { type: 'culture-vworld', channel, status: value.status as 'ready' | 'error',
    ...(typeof value.message === 'string' ? { message: value.message.slice(0, 240) } : {}) };
}

/** Called only after a 3D action. Neither API credentials nor the SDK enter the search bundle. */
export async function vworldAvailable(signal: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 6000);
  try {
    if (signal.aborted) return false;
    const response = await fetch('/api/maps/vworld/config', { credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) return false;
    const config: unknown = await response.json();
    return !controller.signal.aborted && !!config && typeof config === 'object' && (config as { available?: unknown }).available === true;
  } catch { return false; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}

export function vworldFrameUrl(latitude: number, longitude: number, label: string, channel: string): string {
  const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude), label, channel });
  return `/api/maps/vworld/frame?${params}`;
}
