import { ImageResponse } from 'next/og';
import { site, speakers } from '@/lib/content';

export const dynamic = 'force-static';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = `${site.name} — ${site.tagline}`;

/**
 * The share card is the page in miniature: white paper, black type set as
 * heavy and as large as it will go, and the four speaker colours as outlined
 * blocks — the same rotation the app walks when people join a call.
 */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#ffffff',
          color: '#000000',
          padding: '64px',
          borderBottom: '24px solid #000000',
          fontFamily: 'Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ display: 'flex', fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em' }}>
          {site.name}
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 96,
            fontWeight: 700,
            lineHeight: 0.92,
            letterSpacing: '-0.045em',
            maxWidth: 960,
          }}
        >
          {site.tagline}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 14 }}>
            {speakers.map((speaker) => (
              <div
                key={speaker.id}
                style={{
                  width: 72,
                  height: 40,
                  background: speaker.color,
                  border: '5px solid #000000',
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700 }}>
            Free, offline, MIT licensed
          </div>
        </div>
      </div>
    ),
    size,
  );
}
