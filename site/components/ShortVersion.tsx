import { Section } from '@/components/Section';
import { facts } from '@/lib/content';

const FILL = ['bg-s1', 'bg-s2', 'bg-s3', 'bg-s4'] as const;

/**
 * The facts as outlined slabs, the label sitting in a filled bar across the
 * top of each. Two columns, because at this size three would squeeze the
 * measure back down to something you scan instead of read. An odd one out at
 * the end runs the full width rather than sitting alone in half of it.
 */
export function ShortVersion() {
  return (
    <Section index="01" id="short-version" name="The short version">
      <dl className="grid gap-x-8 gap-y-10 lg:grid-cols-2">
        {facts.map((fact, index) => (
          <div
            key={fact.label}
            className={`slab-sm flex flex-col ${
              facts.length % 2 && index === facts.length - 1 ? 'lg:col-span-2' : ''
            }`}
          >
            <dt className={`label border-b-[3px] border-ink px-5 py-3 ${FILL[index % FILL.length]}`}>
              {fact.label}
            </dt>
            <dd className="px-5 py-5 text-[1.0625rem] leading-[1.55] text-ink-2">{fact.body}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
