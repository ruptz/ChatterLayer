import { CaptionStage } from '@/components/CaptionStage';
import { site } from '@/lib/content';

/** The three things people want to know before they read a word of prose. */
const spec = [
  { term: 'Runs on', value: 'Windows, macOS, Linux' },
  { term: 'Costs', value: 'Nothing. MIT licensed' },
  { term: 'Sends your audio', value: 'Nowhere' },
];

export function Hero() {
  return (
    <div id="top" className="page">
      <div className="pt-12 pb-20 sm:pt-16 sm:pb-24">
        <h1 className="display max-w-[16ch]">{site.tagline}</h1>

        <div className="mt-12 grid12 gap-y-10">
          <div className="col-span-12 lg:col-span-7">
            <p className="max-w-[34rem] text-[1.1875rem] leading-[1.55] text-ink-2">
              ChatterLayer puts a bot in your Discord voice call, transcribes whoever you switch
              on, and draws their words into OBS in their own colour. The speech never leaves your
              PC.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-5">
              <a href={site.releasesUrl} className="btn bg-s1 px-7 py-4 text-[1.0625rem] text-ink">
                Download for free
              </a>
              <a href={site.repoUrl} className="link-underline text-[1.0625rem] font-semibold">
                Source on GitHub
              </a>
            </div>
          </div>

          {/* The spec block: three facts, outlined, no prose. */}
          <dl className="slab-sm col-span-12 self-start lg:col-span-5">
            {spec.map((item, index) => (
              <div
                key={item.term}
                className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3.5 ${
                  index > 0 ? 'border-t-[3px] border-ink' : ''
                }`}
              >
                <dt className="label text-ink-3">{item.term}</dt>
                <dd className="text-[1.0625rem] font-bold">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-12">
          <CaptionStage />
        </div>
      </div>
    </div>
  );
}
