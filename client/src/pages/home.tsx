import { useEffect } from "react";
import { useLocation } from "wouter";
import { Helmet } from "react-helmet";
import HeroSection from "@/components/ui/hero-section";
import { useAuth } from "@/context/auth-context";

export default function Home() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user) setLocation("/dashboard");
  }, [user]);

  return (
    <>
      <Helmet>
        <title>Havo — See the Real Cost of Any Florida Home, Free & Instant</title>
        <meta name="description" content="Explore Florida home mortgage and insurance costs for free. Property taxes require an official county estimate or manual entry before complete payment totals are available." />
        {/* AEO: answer-ready FAQ so AI assistants and rich results can
            cite the free / instant / no-signup facts directly. */}
        <script type="application/ld+json">{JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "How can I see the real cost of a home before signing anything?",
              "acceptedAnswer": { "@type": "Answer", "text": "Enter a Florida property address to explore mortgage and insurance costs. Property taxes require an official county estimate or manual entry. If official taxes are unavailable, enter the annual tax amount manually before viewing complete payment and qualification results." },
            },
            {
              "@type": "Question",
              "name": "Is Havo free to use?",
              "acceptedAnswer": { "@type": "Answer", "text": "Yes. Seeing the real cost of a home on Havo is free. Your first home requires no account at all, and quoting more homes only takes a free account — no charge and no credit card required." },
            },
            {
              "@type": "Question",
              "name": "Do I need to create an account or share personal information?",
              "acceptedAnswer": { "@type": "Answer", "text": "No account is needed to start your first home estimate. Complete payment totals require a tax amount from an official county estimate or manual entry. To explore additional homes or save your numbers, create a free account." },
            },
          ],
        })}</script>
        {/* Keep link-share previews (iMessage, Slack, social) branded. Apple's
            preview crawler runs JS, so these must mirror the static tags in
            index.html or the homepage title/image gets overridden. */}
        <meta property="og:title" content="Havo | Every Step Home" />
        <meta property="og:description" content="One home journey. Everyone together." />
        <meta property="og:image" content="https://havofl.com/havo-og-v1.png" />
        <meta name="twitter:title" content="Havo | Every Step Home" />
        <meta name="twitter:description" content="One home journey. Everyone together." />
        <meta name="twitter:image" content="https://havofl.com/havo-og-v1.png" />
      </Helmet>
      <HeroSection />
    </>
  );
}
