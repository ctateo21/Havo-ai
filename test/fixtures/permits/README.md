# PA permit captures

Read-only checks performed 2026-11-17. These are minimized **permit-only**
extracts, not whole parcel pages. Owner/contractor fields and surrounding
property data were deliberately discarded.

- Manatee: 7755 Pine Trace Dr, PARID 2051711709; public permits JSON requested by `showPermits()` on the PA parcel page. Two of five records retained.
- Lee: 9793 Deerfoot Dr, FolioID 10207619; expanded PermitDetails box. Its dates are **received dates**, not verified issue dates.
- Collier: 940 Montego Ct, FolioID 57647440005; framed search, I Agree, Site Address, Detail tab. Six issued-date records; an undated seventh record cannot support issue-date credits.
- Pasco: parcel 26-25-20-0190-01200-0220; PA page only links to external permitting.
- Polk: parcel 242820239230000032; permits section directs visitors to issuing agency, with no records.
- Hernando: 3301 Northeast Pkwy, key 1738622; no permits section.
- Sarasota: no parcel capture: robots.txt explicitly disallows `/propertysearch/parcel/` and related detail paths.

Fixtures do not imply full county coverage. No links to issuing-agency portals
were followed.
