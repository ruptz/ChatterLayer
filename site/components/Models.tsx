import { Section } from '@/components/Section';
import { engineFamilies, expectations, models, modelNotes, sampleClip } from '@/lib/content';

const columns = ['Model', 'Download', 'RAM', 'Delay', 'Speakers', 'Punctuation'] as const;

/**
 * The evidence section. Everything here is a measurement the app can produce
 * on demand, which is why it gets a real table rather than three feature
 * cards — and why the sample clip is the last word. Adjectives about accuracy
 * are cheap; five transcripts of the same eleven seconds are not.
 *
 * The two recommended rows are filled rather than starred, so the answer to
 * "which one do I pick" survives a squint.
 */
export function Models() {
  return (
    <Section
      index="06"
      id="models"
      name="Nine models, four engines"
      lede="You need exactly one. The app marks the one that fits your PC, and you can change your mind later."
    >
      <dl className="grid gap-x-8 gap-y-10 lg:grid-cols-2">
        {engineFamilies.map((family, index) => (
          <div key={family.kind} className="slab-sm flex flex-col">
            <dt
              className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b-[3px] border-ink px-5 py-3 ${
                index === 0 ? 'bg-s4' : 'bg-s1'
              }`}
            >
              <span className="label">{family.kind}</span>
              <span className="text-[0.9375rem] font-medium text-ink/70">{family.models}</span>
            </dt>
            <dd className="px-5 py-5 text-[1.0625rem] leading-[1.55] text-ink-2">{family.body}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-12 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[54rem] border-collapse border-[3px] border-ink text-left">
          <caption className="sr-only">
            Every speech model ChatterLayer can download, with its size, memory use, caption delay
            and how many simultaneous speakers it keeps up with.
          </caption>
          <thead>
            <tr className="bg-ink text-paper">
              {columns.map((column) => (
                <th key={column} scope="col" className="label px-4 py-3">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr
                key={model.name}
                className={`border-t-[3px] border-ink align-baseline ${
                  model.recommended ? 'bg-s2' : ''
                }`}
              >
                <th scope="row" className="px-4 py-4 text-[1.0625rem] font-extrabold">
                  {model.name}
                  {model.recommended ? (
                    <span className="mt-1 block text-[0.9375rem] font-semibold">
                      {model.recommended}
                    </span>
                  ) : null}
                </th>
                <td className="tnum px-4 py-4 text-[1rem] text-ink-2">{model.download}</td>
                <td className="tnum px-4 py-4 text-[1rem] text-ink-2">{model.ram}</td>
                <td className="tnum px-4 py-4 text-[1rem] text-ink-2">{model.delay}</td>
                <td className="tnum px-4 py-4 text-[1rem] text-ink-2">{model.speakers}</td>
                <td className="px-4 py-4 text-[1rem] text-ink-2">
                  {model.punctuation ? 'Yes' : 'No'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note mt-4 max-w-[46rem]">
        Measured on a Ryzen 5 5600X against real speech. Speakers is the point at which captions
        start arriving late, not a hard limit. Vosk Large and Gigaspeech are extrapolated from
        model size.
      </p>

      <dl className="mt-14 grid gap-x-8 gap-y-10 lg:grid-cols-2">
        {modelNotes.map((note) => (
          <div key={note.model} className="slab-flat px-5 py-5">
            <dt className="h3">{note.model}</dt>
            <dd className="mt-3 text-[1.0625rem] leading-[1.55] text-ink-2">{note.body}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-16">
        <h3 className="h3 border-t-[3px] border-ink pt-5">The same clip, five ways</h3>
        <p className="mt-4 max-w-[40rem] text-[1.0625rem] leading-[1.6] text-ink-2">
          {sampleClip.caption}
        </p>

        <dl className="slab-sm mt-6">
          {sampleClip.lines.map((line, index) => (
            <div
              key={line.model}
              className={`grid gap-2 px-5 py-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8 ${
                index > 0 ? 'border-t-[3px] border-ink' : ''
              }`}
            >
              <dt className="label text-ink-3 lg:pt-1">{line.model}</dt>
              <dd className="text-[1.125rem] leading-[1.45] tracking-[-0.012em]">{line.text}</dd>
            </div>
          ))}
        </dl>

        <p className="note mt-4 max-w-[46rem]">{sampleClip.note}</p>
      </div>

      <div className="mt-16">
        <h3 className="h3 border-t-[3px] border-ink pt-5">What you should expect</h3>
        <ul className="mt-6 max-w-[44rem] space-y-5">
          {expectations.map((item) => (
            <li
              key={item.slice(0, 32)}
              className="border-l-[6px] border-ink pl-5 text-[1.0625rem] leading-[1.6] text-ink-2"
            >
              {item}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
