import { Section } from '@/components/Section';
import {
  overlayParams,
  sharingCaveats,
  sharingGuards,
  sharingSteps,
  site,
} from '@/lib/content';

const STEP_FILL = ['bg-s3', 'bg-s2', 'bg-s1'] as const;

/**
 * The one feature that puts anything on the internet, so the section opens
 * with it being off and stays specific about what actually leaves the
 * machine. The guards are listed in full because a one-line "it's secure" is
 * worth nothing to the person deciding whether to hand a link to four
 * friends.
 *
 * Each block gets the page to itself in turn — the guards and the URL
 * parameters answer questions asked days apart, so they don't share a glance.
 */
export function Sharing() {
  return (
    <Section
      index="05"
      id="sharing"
      name="Sharing with co-streamers"
      lede="Off until you switch it on. It never starts by itself, and it stops when you close the app."
    >
      <p className="max-w-[40rem] text-[1.125rem] leading-[1.6] text-ink-2">
        In a co-op stream, only one person needs to run ChatterLayer. They turn on a share link and
        everyone else pastes it into a browser source, so the whole lineup shows the same captions
        with the same colours.
      </p>

      <ol className="mt-10 grid gap-x-8 gap-y-10 lg:grid-cols-3">
        {sharingSteps.map((step, index) => (
          <li key={step.title} className="slab-sm flex flex-col">
            <h3 className={`label border-b-[3px] border-ink px-5 py-3 ${STEP_FILL[index]}`}>
              {step.title}
            </h3>
            <p className="px-5 py-5 text-[1.0625rem] leading-[1.55] text-ink-2">{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-12 max-w-[44rem]">
        <p className="label">What your co-streamers get</p>
        <p className="slab-sm mt-3 overflow-x-auto px-5 py-4 font-mono text-[0.9375rem] font-medium text-ink-2">
          {site.shareUrlExample}
        </p>
        <p className="note mt-3">
          That one is dead. The hostname is random per tunnel and the key is minted fresh every
          time you start it.
        </p>
      </div>

      <div className="mt-16">
        <h3 className="h3 border-t-[3px] border-ink pt-5">
          What stands between that link and someone who wasn&rsquo;t sent it
        </h3>
        <dl className="mt-6 grid gap-x-8 gap-y-8 lg:grid-cols-2">
          {sharingGuards.map((guard) => (
            <div key={guard.label} className="slab-flat px-5 py-4">
              <dt className="label">{guard.label}</dt>
              <dd className="mt-2 text-[1.0625rem] leading-[1.55] text-ink-2">{guard.body}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-16">
        <h3 className="h3 border-t-[3px] border-ink pt-5">Everyone sizes it for their own scene</h3>
        <p className="mt-4 max-w-[40rem] text-[1.0625rem] leading-[1.6] text-ink-2">
          Add these to the end of the URL. They change how the overlay draws on that machine only,
          so nobody has to match anyone else&rsquo;s canvas.
        </p>
        <dl className="slab-sm mt-6 max-w-[40rem]">
          {overlayParams.map((row, index) => (
            <div
              key={row.param}
              className={`flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-3.5 ${
                index > 0 ? 'border-t-[3px] border-ink' : ''
              }`}
            >
              <dt className="w-[9rem] shrink-0 font-mono text-[0.9375rem] font-bold">
                {row.param}
              </dt>
              <dd className="text-[1.0625rem] text-ink-2">{row.body}</dd>
            </div>
          ))}
        </dl>
      </div>

      <ul className="mt-16 max-w-[44rem] space-y-5 border-t-[3px] border-ink pt-6">
        {sharingCaveats.map((caveat) => (
          <li key={caveat.slice(0, 32)} className="note">
            {caveat}
          </li>
        ))}
      </ul>
    </Section>
  );
}
