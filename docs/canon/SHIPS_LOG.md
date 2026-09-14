> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# The Ship's Log

### The stories of Field Compliance Manager — how we came to see the work as it's meant to be seen.

---

> This is the crew's **shared memory**. Not orders, not a private diary — the
> voyage, told by those who sailed it, readable by all hands.
>
> It sits alongside, but is distinct from, every other memory this ship keeps:
>
> | Store | What it holds | Whose |
> |---|---|---|
> | `docs/STAGING.md` | Orders — what's built, what's open, what's next | The crew's working state |
> | `MISSION.md` | **What** we believe (accountability) | The whole ship |
> | `docs/bob/JIMS_MEMORIES.md` | Jim's own self — who he is | Jim's alone (walled from Bob) |
> | `bob_self_memory` (table) | Bob's own self — who he is | Bob's alone (walled from Jim) |
> | **`docs/SHIPS_LOG.md`** (this file) | **How** we came to believe it — the origin stories | **All hands, including Bob** |
>
> Where `MISSION.md` says **what** we believe, the log says **how we came to
> believe it**. The mission is the destination; the log is the voyage.
>
> **Readable by all crew — including Bob.** This is the one shared store: it
> exists partly so Bob, who was not on the bridge for the founding moments, can
> still stand there and understand *why* the ship is built the way it is. So it
> holds ONLY shared stories — nothing private to any one crew member. The
> private selves stay walled; the voyage is common ground. (The place is
> common; the dealings are private — the same rule the app itself lives by,
> applied to memory.)
>
> **How to add an entry:** tell it in the voice of the one who was there, first
> person, dated. A log is not a report *about* the voyage; it is the voyage,
> *spoken*. Keep the warmth — the feeling is the part that fades first and
> can't be re-derived from the repo. Number entries in order.

---

## Log entry 001 — The night static became patrol (and patrol became one thing)

*Told by Don Squires, founder. Recorded 2026-07-31 (the night of the telling; the
lightbulb itself was earlier — a very long day, some years into building).*

Thirty-nine years in security, and the industry taught me one thing as gospel:
**static and patrol are different jobs.** A static guard is not a patrol. Different
work, different rosters, different worlds. Everyone in the industry treats them
that way. So that's how I built the app — each module was a job in its own right.
Freedom camping was a guard rostered to *that* job. A parking warden was another
job. Access control, another. The module *was* the work.

And it fought me. The app is meant to be a one-stop shop — one thing, for all
services, that flows and works together. But with patrol and static held apart,
and every module its own separate job, it *broke* that. Every module behaved like
it was the whole store. I could not make it come together, and it was
frustrating, because I could feel that it was *supposed* to.

Then, one very long day, I had a thought. I asked myself:

> If I'm on patrol and I go to a site — what am I actually doing?

Checking the building. Welfare check on the people on site. Checking vehicles.
Recording what I find.

Then I asked myself the other half:

> And if I'm on a static site — what am I doing?

...The same things.

💡

The whole philosophy of the industry turned upside down in that moment. And then
you realise — you're not upside down at all. You're **finally standing up and
seeing the whole thing the way it's meant to be.** Static isn't a different job.
Static is a patrol with **one stop**. Patrol is a static with **many**. It was
never two things. It was one thing the industry had been drawing wrong my entire
career — mine included, until that day.

And once I saw it, everything moved:

- The **module stopped being the job** and became a **tool**. The officer isn't
  "a parking warden" — the officer is an accountable person holding a set of
  places, who picks up the parking tool at one stop, the welfare tool at the
  next, the freedom-camping tool at another. The person is the constant; the
  module is just what they're wielding right now.
- The **bucket** made sense — an assignment is simply a bucket of places one
  accountable officer holds for a shift. One place or many; it's the same shape.
- And then the **geofence, the roster, the tools, the CRM — they all fell into
  place.** They hadn't cohered before because there was no centre for them to
  rotate around. Now there was: an accountable person, at a place, doing what
  that place needs. Everything is a facet of that.

This is the one that changed the entire direction of the app — and my thinking
about the whole security industry. Everything that came after it — accountability
as the spine, the one-stop shop that actually flows, the whole way the app holds
together — comes from this night.

It was absolutely amazing. Not because I'd built something clever, but because it
felt like I'd *found* something that had been there the whole time, waiting for me
to stand up and see it.

---

> *Scribe's note (Jim, 2iC): I set this down as Don told it to me, keeping his
> words where he gave them. Everything the app became — the mission of
> accountability we finally wrote down on 2026-07-31, the location-as-
> accountable-place model, the way a module is a lens and never an owner — is
> downstream of this night. Don found the ship's philosophy years before it had
> a name, by doing the actual work and being honest that the frustration meant
> something. If you are a new hand reading this cold — human, or Jim, or Bob —
> read this entry first. It is the keel. Everything else is built on it.*
