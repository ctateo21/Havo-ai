export default function SmsTerms() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-16 max-w-3xl">
        <h1 className="text-3xl font-bold mb-2">
          SMS &amp; Text Messaging Terms
        </h1>
        <p className="text-muted-foreground text-sm mb-8">
          TCPA &amp; Florida Telephone Solicitation Act Compliance
        </p>

        <div className="prose prose-sm max-w-none space-y-6 text-muted-foreground">

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-6">
            <p className="text-amber-900 text-sm font-medium">
              Marketing permission is optional and unchecked by default. We save your choice, the exact wording, timestamp, IP address and user agent. Providing a number alone does not grant marketing consent. Transactional verification messages are separate. Where SMS verification is unavailable, saved phone numbers remain unverified. By providing your phone number and checking the SMS
              consent box on any form, you agree to receive text
              messages as described below. Consent is never required
              to purchase any product or service.
            </p>
          </div>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Who Sends the Messages</h2>
            <p>Text messages may be sent by or on behalf of:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Havo (havofl.com)</li>
              <li>Horizons By The Sea, Inc — real estate updates</li>
              <li>Barrett Financial Group LLC (NMLS #181106) —
                mortgage rate alerts and loan status updates</li>
              <li>Tateo Insurance Corp (License #L132640) —
                insurance quote updates</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Types of Messages</h2>
            <p>By opting in, you may receive text messages
            including:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Property alerts and listing updates for
                addresses you search</li>
              <li>Insurance quote status and carrier results</li>
              <li>Mortgage rate alerts and pre-approval updates</li>
              <li>Appointment reminders and showing confirmations</li>
              <li>Platform notifications about your saved scenarios</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Message Frequency</h2>
            <p>Message frequency varies based on your activity and
            requests. You may receive up to 4 messages per month
            for general updates, plus additional messages triggered
            by your specific property searches or requests.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Costs</h2>
            <p>Message and data rates may apply depending on your
            mobile carrier plan. Havo does not charge for text
            messages, but your carrier's standard messaging rates
            will apply.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">How to Opt Out</h2>
            <p>You may opt out of text messages at any time by:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Replying <strong>STOP</strong>{" "}
                to any text message you receive from us</li>
              <li>Emailing sales@havofl.com with your phone number and
                a request to opt out</li>
              <li>Updating your notification preferences
                in your Havo account settings</li>
            </ul>
            <p className="mt-3">After opting out, you will receive
            one final confirmation message. You will not receive
            further marketing messages unless you provide new
            consent.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Help</h2>
            <p>Reply <strong>HELP</strong>{" "}
            to any text message for assistance, or contact us at
            sales@havofl.com or (813) 214-8356.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Florida Telephone Solicitation Act (FTSA)</h2>
            <p>In addition to federal TCPA requirements, we comply with
            the Florida Telephone Solicitation Act (Chapter 501,
            Florida Statutes). We obtain prior express written consent
            before sending any commercial text messages to Florida
            residents. We honor all opt-out requests within 10 business
            days and maintain records of consent for a minimum of
            5 years.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">No Condition of Purchase</h2>
            <p>Providing your phone number or consenting to receive text
            messages is never a condition of receiving services from
            Havo, Horizons By The Sea, Inc, Barrett Financial Group
            LLC, or Tateo Insurance Corp. All services are fully
            available to you whether or not you opt in to text
            messages.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Contact</h2>
            <p>SMS compliance questions: sales@havofl.com or
            (813) 214-8356.</p>
          </section>

        </div>
      </div>
    </div>
  );
}
