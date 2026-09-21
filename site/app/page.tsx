import { GetIt } from '@/components/GetIt';
import { Hero } from '@/components/Hero';
import { HowItWorks } from '@/components/HowItWorks';
import { Models } from '@/components/Models';
import { Setup } from '@/components/Setup';
import { Sharing } from '@/components/Sharing';
import { ShortVersion } from '@/components/ShortVersion';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { WhyItExists } from '@/components/WhyItExists';

/**
 * One page, in the order someone actually decides in: what is it, why does it
 * exist, how does it work, how do I set it up, what about my co-streamers, is
 * it any good, and then how do I get it.
 */
export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <ShortVersion />
        <WhyItExists />
        <HowItWorks />
        <Setup />
        <Sharing />
        <Models />
        <GetIt />
      </main>
      <SiteFooter />
    </>
  );
}
