import { Section } from '@/components/Section';
import { requirements, site } from '@/lib/content';

/**
 * The close. No dark band — the page has held one rule the whole way down,
 * that a dark block is always a caption, and breaking it here for a marketing
 * flourish would cost more than the flourish is worth. The weight comes from
 * the outline and the fill instead.
 */
export function GetIt() {
  return (
    <Section
      index="07"
      id="download"
      name="Get it"
      lede="An installer, or a portable build if you'd rather not install anything."
    >
      <div className="grid gap-x-8 gap-y-12 lg:grid-cols-2">
        <div>
          <div className="flex flex-wrap items-center gap-6">
            <a href={site.releasesUrl} className="btn bg-s1 px-7 py-4 text-[1.0625rem] text-ink">
              Download for Windows, macOS or Linux
            </a>
            <a href={site.repoUrl} className="link-underline text-[1.0625rem] font-semibold">
              Source on GitHub
            </a>
          </div>

          <p className="note mt-6 max-w-[38rem]">
            The builds aren&rsquo;t code-signed, because certificates cost money this project
            isn&rsquo;t spending. Windows will show a SmartScreen warning the first time: More
            info, then Run anyway. On macOS the app can clear Gatekeeper&rsquo;s quarantine flag
            for you.
          </p>

          <div className="slab-sm mt-10">
            <h3 className="label border-b-[3px] border-ink bg-s4 px-5 py-3">
              There&rsquo;s a Ko-fi, if you want one
            </h3>
            <p className="px-5 py-5 text-[1.0625rem] leading-[1.55] text-ink-2">
              ChatterLayer is free and it stays free. Nothing is held back, nothing is gated, and
              there&rsquo;s no pro version coming. If it earned its keep on your stream, you can
              throw something at{' '}
              <a href={site.kofiUrl} className="link-underline font-semibold text-ink">
                {site.kofiHandle}
              </a>
              .
            </p>
          </div>
        </div>

        <dl className="slab-sm self-start">
          {requirements.map((row, index) => (
            <div
              key={row.label}
              className={`grid gap-2 px-5 py-4 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-6 ${
                index > 0 ? 'border-t-[3px] border-ink' : ''
              }`}
            >
              <dt className="label sm:pt-0.5">{row.label}</dt>
              <dd className="text-[1.0625rem] leading-[1.55] text-ink-2">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
