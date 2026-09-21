import { CopyField } from '@/components/CopyField';
import { Section } from '@/components/Section';
import { appBehaviour, setupSteps, site } from '@/lib/content';

const FILL = ['bg-s1', 'bg-s2', 'bg-s3', 'bg-s4', 'bg-s1'] as const;

/**
 * Five steps, in the only order they can be done in — the one genuinely
 * sequential thing on the page, so the one place a number earns its keep.
 *
 * The number is a filled block hanging in the margin and everything else runs
 * down a single column. Pushing the detail into a second column put two
 * things at the same height that are read at different times: you follow the
 * step, and only look at the caveat if it goes wrong.
 */
export function Setup() {
  return (
    <Section
      index="04"
      id="setup"
      name="Setup"
      lede="About ten minutes, and most of that is a download bar."
    >
      <ol className="space-y-12">
        {setupSteps.map((step, index) => (
          <li key={step.title} className="grid grid-cols-1 gap-5 sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-7">
            <span
              className={`band-num self-start ${FILL[index % FILL.length]}`}
              aria-hidden="true"
            >
              {String(index + 1).padStart(2, '0')}
            </span>

            <div className="min-w-0 max-w-[42rem]">
              <h3 className="h3">{step.title}</h3>
              <p className="mt-3 text-[1.0625rem] leading-[1.6] text-ink-2">{step.body}</p>

              {step.copyValue ? (
                <div className="mt-5">
                  <CopyField value={step.copyValue} label="Overlay URL for OBS" />
                </div>
              ) : null}

              {step.bullets ? (
                <ul className="slab-sm mt-5">
                  {step.bullets.map((bullet, bulletIndex) => (
                    <li
                      key={bullet}
                      className={`px-5 py-3 text-[1rem] leading-[1.5] text-ink-2 ${
                        bulletIndex > 0 ? 'border-t-[3px] border-ink' : ''
                      }`}
                    >
                      {bullet}
                    </li>
                  ))}
                </ul>
              ) : null}

              {step.link ? (
                <p className="mt-5">
                  <a href={step.link.href} className="btn inline-block bg-paper px-5 py-2.5 text-[1rem]">
                    {step.link.label}
                  </a>
                </p>
              ) : null}

              {step.note ? <p className="note mt-5">{step.note}</p> : null}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-16">
        <h3 className="h3 border-t-[3px] border-ink pt-5">Two things that surprise people</h3>
        <dl className="mt-6 grid gap-x-8 gap-y-10 lg:grid-cols-2">
          {appBehaviour.map((item, index) => (
            <div key={item.label} className="slab-sm flex flex-col">
              <dt className={`label border-b-[3px] border-ink px-5 py-3 ${index === 0 ? 'bg-s4' : 'bg-s2'}`}>
                {item.label}
              </dt>
              <dd className="px-5 py-5 text-[1.0625rem] leading-[1.55] text-ink-2">{item.body}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="mt-10 max-w-[40rem] text-[1.0625rem] leading-[1.6] text-ink-2">
        Stuck on any of it?{' '}
        <a href={site.issuesUrl} className="link-underline font-semibold text-ink">
          Open an issue
        </a>{' '}
        and say where it went wrong. There&rsquo;s no support queue and no forum — it&rsquo;s one
        person reading them.
      </p>
    </Section>
  );
}
