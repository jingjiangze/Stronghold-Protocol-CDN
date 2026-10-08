// Resolve which upstream release to mirror.
//
// The upstream repository keeps `public/assets/**` out of git and downloads it at install time;
// the only complete, authoritative artifact is the full release zip, which `tools/package.mjs`
// refuses to build unless every file its manifest lists is present. So the sync source is the
// release, and the tag is the version watermark.
//
// Public repository: no credentials needed. In Actions the default GITHUB_TOKEN is used when
// present, which also lifts the anonymous API rate limit.
import { FULL_ZIP_NAME } from './names.mjs';

export const UPSTREAM_REPO = process.env.SP_UPSTREAM_REPO || 'sganggs/Stronghold-Protocol';

function headers() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'stronghold-protocol-cdn',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * @param {string} [tag] upstream tag; empty means "latest release"
 * @returns {Promise<{repo:string, tag:string, publishedAt:string, zip:{name:string,size:number,url:string,sha256:string|null}}>}
 */
export async function resolveRelease(tag) {
  const path = tag
    ? `releases/tags/${encodeURIComponent(tag)}`
    : 'releases/latest';
  const url = `https://api.github.com/repos/${UPSTREAM_REPO}/${path}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`upstream resolve failed: HTTP ${res.status} (${url})`);
  const release = await res.json();

  const wanted = FULL_ZIP_NAME(release.tag_name);
  const zip = (release.assets || []).find((a) => a.name === wanted);
  if (!zip) {
    throw new Error(
      `release ${release.tag_name} has no ${wanted} — the packaging layout changed, refusing to guess`,
    );
  }
  return {
    repo: UPSTREAM_REPO,
    tag: release.tag_name,
    publishedAt: release.published_at,
    zip: {
      name: zip.name,
      size: zip.size,
      url: zip.browser_download_url,
      // GitHub publishes a sha256 digest per asset; older releases may not have one.
      sha256: (zip.digest || '').replace(/^sha256:/, '') || null,
    },
  };
}

/** Only https, and never a loopback/private/reserved host. */
export function assertPublicHttpsUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error(`refusing non-https url: ${raw}`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateV4(host)) ||
    (host.includes(':') && isPrivateV6(host));
  if (blocked) throw new Error(`refusing private/loopback host: ${host}`);
  return url;
}

function isPrivateV4(host) {
  const [a, b] = host.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(host) {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10
  return false;
}
