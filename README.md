# Club Votes

A place for your club to decide things together. Anyone in the club posts a
yes/no question with a deadline; everyone votes once (and can change their
vote until the deadline); the club discusses it in the comments under each
decision.

## What it does

- **Open decisions** — the main screen lists every open decision newest
  first, split into *Needs your vote* (you haven't voted yet), *You voted*
  (your vote is in, changeable until it ends) and *Recently decided* (the
  closed ones, with their result: "Yes 13 to 4", "Tied 5 to 5", "No votes").
  Every card shows who posted it, how long is left, the tally as a ballot
  box, and Yes/No buttons right on the card.
- **Post a decision** — one filled button opens a short form: a question
  (1–200 characters), optional details (up to 2000) and a deadline picker
  defaulting to three days out. The person who posted picks the deadline and
  can delete their own decision.
- **One decision's screen** — the big ballot box, your Yes/No with a tick on
  your choice, and the comments oldest first. Report someone else's comment,
  delete your own; a footer "Report this decision" records a report for the
  app's admins (nothing is hidden automatically).
- **Rules** — one vote per member per decision, changeable until the
  deadline. Results are visible to everyone while a vote is open; who voted
  which way is never shown, only the totals and your own vote. After the
  deadline the decision closes and votes are refused. Visitors without a
  Homeroom account can read everything but can't vote or comment.

## Running it

    npm ci --include=dev
    npm run build   # compiles the stylesheet
    npm start

On staging, `?demo=1` shows a screen and a half of made-up decisions,
comments and results so the populated screens can be seen. The demo rows
belong to the account viewing them and never appear without `?demo=1`.

## Data notes

- Open/closed is decided against the request's platform-supplied "now"
  (`req.now`), never the database clock or the server's local time.
- The `votes` and `reports` tables are marked `staging:private`: on staging
  their rows stay with the account that made them, and no other member ever
  sees who voted which way or what was reported.
- Demo rows carry a `demo_owner` and are excluded from every response that
  does not ask for the demo.

## Design

See `CLAUDE.md` ("## Design"): warm paper neutrals, brick red only for
posting, deep teal for everything about votes, and the ballot box as the
signature element. The screens the spec drew are kept in
`public/screens.css`; `public/app.js` renders them from the API.
