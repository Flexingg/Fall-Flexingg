import { Share } from '@capacitor/share';
import { isNative } from './platform';

/** Share a link with the system sheet, falling back to the clipboard. Returns how it went. */
export async function shareLink(title: string, text: string, url: string): Promise<'shared' | 'copied' | 'failed'> {
  try {
    if (isNative) {
      await Share.share({ title, text, url, dialogTitle: title });
      return 'shared';
    }
    if (navigator.share) {
      await navigator.share({ title, text, url });
      return 'shared';
    }
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch (err) {
    if ((err as Error).name === 'AbortError') return 'shared';
    try {
      await navigator.clipboard.writeText(url);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
}
