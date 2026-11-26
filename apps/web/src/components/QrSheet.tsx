import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { toast } from './ui';
import '../styles/challenges.css';

/**
 * A big QR code for an invite link, so someone next to you can scan it instead of typing. Always
 * dark on white with a quiet zone: phone cameras struggle with light-on-dark codes.
 */
export function QrSheet({
  title,
  url,
  expiresAt,
  onClose,
}: {
  title: string;
  url: string;
  expiresAt: string;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canvas.current) return;
    QRCode.toCanvas(canvas.current, url, {
      width: 560,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(() => setFailed(true));
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    } catch {
      toast('Could not copy. Press and hold the link instead.');
    }
  }

  const expires = new Date(expiresAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <div
      className="qr-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Invite QR code"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card stack qr-sheet" style={{ gap: 12 }}>
        <b style={{ fontSize: 18 }}>{title}</b>
        <div>
          {failed ? (
            <p className="muted">Could not draw the code. Share the link instead.</p>
          ) : (
            <div className="qr-frame">
              <canvas ref={canvas} aria-label="QR code for the invite link" />
            </div>
          )}
        </div>
        <small className="muted">Scan with a phone camera to open the invite.</small>
        <div className="qr-link">{url}</div>
        <small className="muted">Link expires {expires}</small>
        <div className="row">
          <button className="btn" onClick={copy}>
            Copy link
          </button>
          <button className="btn secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
