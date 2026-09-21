import { Section } from '@/components/Section';
import { latency, pipeline } from '@/lib/content';

const FILL = ['bg-s3', 'bg-s1', 'bg-s4'] as const;

/**
 * The signal path. Three stages, labelled by where they happen rather than
 * numbered — "Discord, your PC, OBS" tells you more than "1, 2, 3", and it
 * makes the privacy claim structural: only the middle box is your machine.
 */
export function HowItWorks() {
  return (
    <Section
      index="03"
      id="how-it-works"
      name="How it works"
      lede="Three hops, and the middle one is the only place your voices are ever decoded."
    >
      <ol className="grid gap-x-8 gap-y-10 lg:grid-cols-3">
        {pipeline.map((stage, index) => (
          <li key={stage.id} className="slab-sm flex flex-col">
            <p className={`label border-b-[3px] border-ink px-5 py-3 ${FILL[index]}`}>
              {stage.kicker}
            </p>
            <div className="px-5 py-5">
              <h3 className="h3">{stage.title}</h3>
              <p className="mt-3 text-[1.0625rem] leading-[1.55] text-ink-2">{stage.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-12 slab-sm max-w-[40rem]">
        <p className="label border-b-[3px] border-ink px-5 py-3">Speech to pixels</p>
        {latency.map((row, index) => (
          <div
            key={row.stage}
            className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-4 ${
              index > 0 ? 'border-t-[3px] border-ink' : ''
            }`}
          >
            <span className="text-[1.0625rem] text-ink-2">{row.stage}</span>
            <span className="tnum text-[1.25rem] font-extrabold tracking-[-0.02em]">
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <p className="note mt-4">Measured on a Ryzen 5 5600X.</p>
    </Section>
  );
}
