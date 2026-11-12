import { Link } from "wouter";
import { Facebook, Instagram, Linkedin,
  Youtube } from "lucide-react";
import barrettLogo from
  "@assets/barrett-financial-group.png";

export default function Footer() {
  return (
    <footer className="bg-[#0F1B3D]
      text-white pt-16 pb-12">
      <div className="container mx-auto
        px-4">
        <div className="grid grid-cols-1
          md:grid-cols-2 lg:grid-cols-4
          gap-8 mb-12">

          {/* Column 1: Brand */}
          <div className="col-span-1
            lg:col-span-1">
            <div className="mb-7">
              <span className="text-white
                font-display font-extrabold
                text-5xl tracking-tight">
                havo
                <span className=
                  "text-primary">.</span>
              </span>
            </div>
            <p className="mb-7
              text-white/90 leading-relaxed
              text-base">
              Our mission is to provide
              unparalleled expertise and
              comprehensive support to
              clients in every step of their
              real estate journey. With Havo,
              you benefit from a team that
              knows every aspect of the real
              estate, mortgage, &amp;
              insurance industry.
            </p>
            <div className="flex gap-4 mb-6">
              <a href="https://www.instagram.com/havofl/" target="_blank" rel="noopener noreferrer">Instagram</a>
              <a href="https://www.tiktok.com/@havofl" target="_blank" rel="noopener noreferrer">TikTok</a>
            </div>
            <div className="mt-2">
              <a href="tel:+18132148356"
                className="block text-white/70
                  text-sm
                  hover:text-[#00B6A9]">
                (813) 214-8356
              </a>
              <a href=
                "mailto:sales@havofl.com"
                className="block text-white/70
                  text-sm
                  hover:text-[#00B6A9]">
                sales@havofl.com
              </a>
            </div>
          </div>

          {/* Column 2: Real Estate
              Brokerage */}
          <div className="col-span-1
            lg:col-span-1">
            <div className="space-y-10">

              {/* Real Estate — FREC
                  Rule 61J2-10.025:
                  licensed brokerage name
                  must appear adjacent to
                  contact info */}
              <div>
                <h5 className="font-semibold
                  text-[#00B6A9] text-sm
                  uppercase tracking-wider
                  mb-2">
                  Real Estate Brokerage
                </h5>
                <p className="font-medium
                  text-white text-sm">
                  Horizons By The Sea, Inc
                </p>
                <p className="text-white/70
                  text-sm">
                  License #CQ216715
                </p>
                <p className="text-white/70
                  text-sm">
                  661 S Collier Blvd
                </p>
                <p className="text-white/70
                  text-sm">
                  Marco Island, FL 34145
                </p>
                <p className="text-white/70
                  text-sm mt-1">
                  Licensed Real Estate
                  Brokerage · FL
                </p>
              </div>

              {/* Mortgage — NMLS/SAFE Act:
                  company name + NMLS ID
                  required in all ads */}
              <div>
                <h5 className="font-semibold
                  text-[#00B6A9] text-sm
                  uppercase tracking-wider
                  mb-2">
                  Mortgage Loan Originator
                </h5>
                <p className="font-medium
                  text-white text-sm">
                  Barrett Financial Group LLC
                </p>
                <p className="text-white/70
                  text-sm">
                  NMLS #181106
                </p>
                <p className="text-white/70
                  text-sm">
                  2701 E Insight Way,
                  Suite 150
                </p>
                <p className="text-white/70
                  text-sm">
                  Chandler, AZ 85286
                </p>
                <p className="text-white/70
                  text-sm mt-1">
                  Licensed in Multiple
                  States · Individual
                  MLO NMLS #1223755
                </p>
                <div className="mt-4 flex
                  flex-col items-start gap-2">
                  <a href=
                    "https://www.barrettfinancial.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block
                      bg-white rounded-md
                      p-2">
                    <img
                      src={barrettLogo}
                      alt="Barrett Financial
                        Group LLC"
                      className="w-auto h-auto
                        max-w-[160px]"
                    />
                  </a>
                  <span className=
                    "text-white/60 text-xs">
                    Powered by Barrett
                    Financial Group LLC
                  </span>
                </div>
              </div>

            </div>
          </div>

          {/* Column 3: Insurance */}
          <div className="col-span-1
            lg:col-span-1">
            <div className="space-y-10">

              {/* Insurance — FL §627.4085:
                  agency name + license +
                  agent name + agent license
                  required */}
              <div>
                <h5 className="font-semibold
                  text-[#00B6A9] text-sm
                  uppercase tracking-wider
                  mb-2">
                  Insurance Agency
                </h5>
                <p className="font-medium
                  text-white text-sm">
                  Tateo Insurance Corp
                </p>
                <p className="text-white/70
                  text-sm">
                  License #L132640
                </p>
                <p className="text-white/70
                  text-sm">
                  Licensed Insurance
                  Agency · FL
                </p>

                <div className="mt-4
                  pt-4 border-t
                  border-white/10">
                  <p className="text-white/50
                    text-xs uppercase
                    tracking-wider mb-1">
                    Licensed Agent
                  </p>
                  <p className="text-white/80
                    text-sm font-medium">
                    Paul Christian Tateo
                  </p>
                  <p className="text-white/70
                    text-sm">
                    License #W142842
                  </p>
                  <p className="text-white/70
                    text-sm">
                    0220 · Licensed
                    Insurance Agent
                  </p>
                </div>
              </div>

            </div>
          </div>

          {/* Column 4: Resources & Legal */}
          <div>
            <div className="mb-8">
              <h4 className="text-xl
                font-semibold text-[#00B6A9]
                mb-4">
                Resources
              </h4>
              <ul className="space-y-2">
                <li>
                  <Link href="/education"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    Florida Real Estate FAQs
                  </Link>
                </li>
                <li>
                  <Link href=
                    "/florida-homeowners-insurance-cost"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    FL Insurance Cost Guide
                  </Link>
                </li>
                <li>
                  <Link href=
                    "/florida-flood-zones-explained"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    FL Flood Zones Explained
                  </Link>
                </li>
                <li>
                  <Link href=
                    "/florida-real-estate-closing-costs"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    FL Closing Costs Guide
                  </Link>
                </li>
                <li>
                  <Link href=
                    "/florida-property-tax-calculator"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    FL Property Tax Guide
                  </Link>
                </li>
                <li>
                  <Link href=
                    "/mortgage-payment-calculator-florida"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    FL Mortgage Guide
                  </Link>
                </li>
                <li>
                  <a
                    href="https://www.nmlsconsumeraccess.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    NMLS Consumer Access ↗
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-xl
                font-semibold text-[#00B6A9]
                mb-4">
                Legal
              </h4>
              <ul className="space-y-2">
                <li>
                  <Link href="/terms"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    Terms &amp; Conditions
                  </Link>
                </li>
                <li>
                  <Link href="/privacy"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/fair-housing"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    Fair Housing Notice
                  </Link>
                </li>
                <li>
                  <Link href="/sms-terms"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    SMS &amp; Text Terms
                  </Link>
                </li>
                <li>
                  <Link href="/accessibility"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    Accessibility
                  </Link>
                </li>
                <li>
                  <Link href="/sitemap"
                    className="text-white/90
                      hover:text-[#00B6A9]">
                    Sitemap
                  </Link>
                </li>
              </ul>
            </div>

            {/* Equal housing / Equal credit
                disclosures — required for
                real estate and mortgage */}
            <div className="mt-6 pt-4
              border-t border-white/10">
              <p className="text-white/50
                text-[10px] leading-relaxed">
                Equal Housing Opportunity.
                Equal Credit Opportunity
                Lender. Barrett Financial
                Group LLC NMLS #181106.
                Individual MLO NMLS #1223755.
              </p>
            </div>
          </div>

        </div>

        {/* Diagonal stripe decoration
            — unchanged */}
        <div className="w-full h-6
          overflow-hidden relative mt-8">
          <div className="absolute bottom-0
            right-0 w-full h-12
            bg-[#00B6A9]/20"
            style={{
              clipPath: "polygon(0 100%," +
                " 100% 0, 100% 100%," +
                " 0% 100%)",
              background: "repeating-linear" +
                "-gradient(45deg," +
                " rgba(0,182,169,0.2)," +
                " rgba(0,182,169,0.2) 10px," +
                " rgba(0,182,169,0.35) 10px," +
                " rgba(0,182,169,0.35) 20px)"
            }}>
          </div>
        </div>

      </div>
    </footer>
  );
}
