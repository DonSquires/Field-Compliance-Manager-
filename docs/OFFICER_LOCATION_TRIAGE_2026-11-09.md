# Officer Location Triage

Issue: https://github.com/DonSquires/Field-Compliance-Manager-/issues/450
Reported route: https://www.fcmanager.co.nz/officer
Production baseline: `5209983b90d646efb3b753e207acfc420b6efd3e`.

## Before

The officer reported "Finding location" with a last-known address while an
assignment was in progress. The site and its static working zone are separate
facets; bounded live metadata reads found both marked verified with geometry.
The active assignment links to the verified site. A second similarly named site
record is not that working zone. No verification flags or contract links were
changed. Current device permission, fix freshness, accuracy and location remain
unverified; an installed app is not proof of a current GPS fix.

## During

Atlas maps `context/ServiceRelationshipContext` to the authorized operational
resolver. The schema wrapper requires an authenticated caller and organization
access. The browser previously awaited that RPC and reverse-geocoding together.
A delayed address response kept a successful geofence result in "locating";
an address failure made it "unavailable". Missing resolver rows were incorrectly
labelled "outside_geofence". These defects were reproduced synthetically.

## After

The local repair settles geofence state independently of street-address lookup,
rejects missing resolver results as unavailable, and invalidates pending callbacks
on GPS errors or watch cleanup. It does not infer a new boundary, auto-verify a
place, change entitlements, or write attendance. Site and zone contract semantics
remain unchanged; a missing zone ID on a site-linked shift is not by itself proof
of a broken contract.

## Verification

- Eleven focused provider, scope and location-pill unit tests passed.
- Fourteen desktop/mobile officer navigation browser cases passed.
- Web and browser TypeScript checks passed.
- Synthetic screenshots are retained by Playwright under
  `officer-navigation-officer-a05bd--geocoding-is-still-pending-*`.
- The banner resolves before the address response and displays the address when
  it arrives; the location UI stays within desktop and phone viewports.
- No real-user login, production GPS history, patient records or attendance
  mutation was used. Screenshots contain synthetic fixture data only.

Protected PR/CI and serving-build verification are release gates. After release,
the reporting officer must refresh the installed app and confirm the banner on
the actual phone. If it still fails, inspect its expanded location error and the
device's location permission/fix state before changing geofence data.