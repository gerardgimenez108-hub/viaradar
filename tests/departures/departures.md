# Departure-board browser scenarios

All fixture trains are synthetic, isolated by browser routing, and never written to live history.

1. Published, estimated, unknown and cancelled rows remain distinct. Historical percentages say "historical share".
2. A 390px mobile viewport and 1440px desktop viewport have no horizontal overflow. Line filtering and the installation dialog work.
3. Losing connectivity hides platform/time live claims but preserves a clearly labelled last-known cancellation.
4. Malformed API JSON produces a recoverable error without an unhandled browser exception.
5. On the first installation, JavaScript and CSS are precached. Offline reload opens the shell with no cached train data. API responses never enter the service-worker cache.
