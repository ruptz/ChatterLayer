import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="page">
        <div className="max-w-[44rem] py-24 sm:py-32">
          <h1 className="display">Nothing here.</h1>
          <p className="mt-8 text-[1.1875rem] leading-[1.55] text-ink-2">
            ChatterLayer is a single page, so whatever you were after is on it.
          </p>
          <p className="mt-10">
            <a href="/" className="btn inline-block bg-s2 px-7 py-4 text-[1.0625rem] text-ink">
              Back to the start
            </a>
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
