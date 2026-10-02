import { getApiBase } from '../lib/api';

/** Privacy policy, terms and account-deletion pages, served by the Gauntlet server. */
export function LegalLinks() {
  const base = getApiBase();
  const link = (path: string, label: string) => (
    <a href={`${base}${path}`} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
  return (
    <p className="muted center" style={{ fontSize: 12, marginTop: 18 }}>
      {link('/privacy', 'Privacy')} · {link('/terms', 'Terms')} ·{' '}
      {link('/delete-account', 'Delete account')}
    </p>
  );
}
