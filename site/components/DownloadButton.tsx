'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { downloads, site, type Download } from '@/lib/content';

type Asset = { url: string; name: string; size: number };
type Release = { tag: string; page: string; assets: Record<string, Asset> };
type Visitor = 'windows' | 'mac-arm' | 'mac-intel' | 'linux' | 'handheld';

const PRIMARY: Record<Exclude<Visitor, 'handheld'>, string> = {
  windows: 'win-setup',
  'mac-arm': 'mac-arm',
  'mac-intel': 'mac-intel',
  linux: 'appimage',
};

const CACHE_KEY = 'chatterlayer:latest-release';

/* The page has more than one button; they share one request. */
let pending: Promise<Release | null> | null = null;

function latestRelease(): Promise<Release | null> {
  pending ??= (async () => {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) return JSON.parse(cached) as Release;
    } catch {
      // Storage blocked. Ask GitHub instead.
    }

    try {
      const response = await fetch(site.latestReleaseApi, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        tag_name: string;
        html_url: string;
        assets: { name: string; size: number; browser_download_url: string }[];
      };

      const assets: Record<string, Asset> = {};
      for (const download of downloads) {
        const asset = body.assets.find((a) => download.match.test(a.name));
        if (asset) assets[download.key] = { url: asset.browser_download_url, name: asset.name, size: asset.size };
      }
      const release = { tag: body.tag_name, page: body.html_url, assets };

      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(release));
      } catch {
        // Not worth anything more than a second request on the next page load.
      }
      return release;
    } catch {
      // Offline, or GitHub's unauthenticated rate limit. The buttons keep
      // pointing at the release page, which is what they were before.
      return null;
    }
  })();
  return pending;
}

type UAData = { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> };

async function detectVisitor(): Promise<Visitor> {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPod/.test(ua)) return 'handheld';
  if (/Macintosh/.test(ua)) {
    // iPadOS asks for the desktop site and says it's a Mac. Touch gives it away.
    if (navigator.maxTouchPoints > 1) return 'handheld';
    // Only Chromium will say which chip. Everyone else gets Apple Silicon,
    // which is every Mac sold since 2020, with Intel one link away.
    const uaData = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
    try {
      const { architecture } = (await uaData?.getHighEntropyValues(['architecture'])) ?? {};
      if (architecture === 'x86') return 'mac-intel';
    } catch {
      // Refused. Fall through to the default.
    }
    return 'mac-arm';
  }
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return 'windows';
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/**
 * The one filled button, pointed at the file that suits the machine reading
 * the page. Without JavaScript, or if GitHub doesn't answer, every link goes to
 * the release page instead, so nothing here can leave someone with no way in.
 *
 * The server render assumes Windows, which is where most streaming PCs are,
 * so the common case never changes label after load.
 */
export function DownloadButton({ aside }: { aside?: ReactNode }) {
  const [visitor, setVisitor] = useState<Visitor>('windows');
  const [release, setRelease] = useState<Release | null>(null);
  const [started, setStarted] = useState<{ download: Download; asset: Asset } | null>(null);

  useEffect(() => {
    let live = true;
    detectVisitor().then((v) => live && setVisitor(v));
    latestRelease().then((r) => live && setRelease(r));
    return () => {
      live = false;
    };
  }, []);

  const hrefFor = (download: Download) => release?.assets[download.key]?.url ?? site.releasesUrl;
  const onPick = (download: Download) => () => {
    const asset = release?.assets[download.key];
    if (asset) setStarted({ download, asset });
  };

  if (visitor === 'handheld') {
    return (
      <div>
        <div className="flex flex-wrap items-center gap-5">
          <a href={site.releasesUrl} className="btn bg-s1 px-7 py-4 text-[1.0625rem] text-ink">
            Windows, macOS and Linux
          </a>
          {aside}
        </div>
        <p className="note mt-4 max-w-[34rem]">
          It runs on your streaming PC, not your phone. Open this page there and the button picks
          the right file.
        </p>
      </div>
    );
  }

  const primary = downloads.find((d) => d.key === PRIMARY[visitor]) ?? downloads[0];
  const others = [
    ...downloads.filter((d) => d.platform === primary.platform && d !== primary),
    ...downloads.filter((d) => d.platform !== primary.platform),
  ];
  const primaryAsset = release?.assets[primary.key];
  const meta = [primary.kind, release?.tag, primaryAsset && megabytes(primaryAsset.size)]
    .filter(Boolean)
    .join(' · ');

  return (
    <div>
      <div className="flex flex-wrap items-center gap-5">
        <a
          href={hrefFor(primary)}
          onClick={onPick(primary)}
          className="btn bg-s1 px-7 py-4 text-[1.0625rem] text-ink"
        >
          {primary.button}
        </a>
        {aside}
      </div>

      <p className="tnum mt-4 text-[0.9375rem] font-bold text-ink-3">{meta}</p>

      <p className="note mt-2 max-w-[38rem]">
        Or:{' '}
        {others.map((download) => (
          <span key={download.key}>
            <a
              href={hrefFor(download)}
              onClick={onPick(download)}
              className="link-underline font-semibold whitespace-nowrap text-ink-2"
            >
              {download.label}
            </a>
            {' · '}
          </span>
        ))}
        <a href={site.releasesUrl} className="link-underline font-semibold text-ink-2">
          Every release
        </a>
      </p>

      <div aria-live="polite">
        {started ? (
          <div className="slab-sm mt-8 max-w-[38rem]">
            <p className="label border-b-[3px] border-ink bg-s2 px-5 py-3">
              Your download has started
            </p>
            <p className="border-b-[3px] border-ink px-5 py-3 font-mono text-[0.9375rem] font-medium break-all">
              {started.asset.name}
            </p>
            <ol>
              {started.download.after.map((step, index) => (
                <li
                  key={step.text}
                  className={`grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 px-5 py-3.5 ${
                    index > 0 ? 'border-t-[3px] border-ink' : ''
                  }`}
                >
                  <span className="tnum font-extrabold">{index + 1}</span>
                  <div className="text-[1rem] leading-[1.5] text-ink-2">
                    {step.text}
                    {step.code ? (
                      <code className="slab-flat mt-2.5 block overflow-x-auto px-3.5 py-2.5 font-mono text-[0.875rem] font-medium whitespace-pre text-ink">
                        {step.code.replace('{file}', started.asset.name)}
                      </code>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            <p className="note border-t-[3px] border-ink px-5 py-3">
              Unsigned isn&rsquo;t unchecked. The{' '}
              <a href={release?.page ?? site.releasesUrl} className="link-underline font-semibold text-ink">
                release page
              </a>{' '}
              lists a Sigstore-signed SHA256 for every file, built by this repo&rsquo;s CI.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
