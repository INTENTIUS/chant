---
schema: 1
id: "ws-083"
title: "A UI review batch is a session"
state: "decided"
area: "D18"
source:
  issue: "INTENTIUS/chant#3350"
  row: "the session kind can't hold a UI review: comment anchor, text, disposition, rounds"
  revision: null
question: "How does the reference workspace's session kind hold a comment-mode review of the app's UI, one record per review batch, so that hud writes it through records new, amend and close instead of keeping it in its own database?"
options:
  - id: "a"
    label: "comments and rounds on the session: each comment anchored, with the agent's answers, a person's replies and how it left the box"
    how: "The session schema takes two optional lists. comments: each {text, by, at, anchor, answers, replies, exit, follow_ups}, numbered from 1 by position; anchor is {route, elements}, each element {selector, tag, text, state: anchored, ambiguous or lost, basis: authored, id, testid or path}; answers are the agent's, one per round, each {round, disposition: handled, skipped or needs-discussion, note, by, at}, the last being current; replies are a person's, each {round from 1, text, by, at}; exit is kept, sent or dismissed once a person decides; follow_ups names the records a comment led to as <kind>:<id>. rounds: each {round, note, by, at, ended}, round 0 being the batch as sent and ended the end of the agent's turn. hud writes the batch with records new when it is sent, amends comments and rounds as answers and replies come in, and closes and seals the session once the batch is kept or sent. The writer conformance script's session carries one such comment."
    tradeoff: "hud's review_batches, review_answers and review_rounds map onto one record with no field of hud's own, and the history hud's upserts drop (each round's answer) is kept. A review session holds verdicts and comments in one shape, so a reader that only wants a decision walk ignores two lists. chant does not check that rounds and answers agree; hud does, as it does today."
  - id: "b"
    label: "a review kind of its own beside the session kind"
    how: "A design/reviews/review.kind.mjs, R-NNNN records with the same comments and rounds, its own states (open, answered, kept, sent) and no verdicts."
    tradeoff: "The review's lifecycle is its own. hud#703 settled on the session kind, studio-037 chose a chant review session, and a second kind would repeat the session's seal, attendance and close."
  - id: "c"
    label: "comments as agenda items and the agent's answers as verdicts"
    how: "Each comment is an agenda text item, and each answer a verdict whose verdict is handled, skipped or needs-discussion."
    tradeoff: "No new list. A verdict judges a record and counts toward its quorum, and an answer is neither; widening the verdict enum would make every quorum reader skip values that are not agree, dissent or abstain, and an agenda item can't hold an anchor or replies."
  - id: "d"
    label: "one record per comment"
    how: "Each comment its own session or record, linked to the batch by an id."
    tradeoff: "Each comment joins to its own work. studio-038 chose one record per batch: the batch is what a person sends, answers and keeps together."
choice:
  option: "a"
  reason: "lex00 decided in hud#703 (D8) that a comment-mode review is the reference workspace's session kind, one record per review batch, with both exits, Keep and Send, and studio-037 to studio-039 record the same. The session already has the attendance, the open and closed states, the close through records close and the seal a review needs, so the review adds only what it lacks: anchored comments, the agent's answers, a person's replies and the rounds they come in. Answers stay apart from verdicts because a verdict judges a record and counts toward a quorum, and handled, skipped or needs-discussion does neither. Each answer is kept per round rather than replaced, since ws-074 makes the record the database and a later round's answer should not erase the earlier one. The issue's disposition (kept, sent or dismissed) is how a comment leaves the box, named exit, while the agent's answer keeps hud's handled, skipped and needs-discussion as its disposition, which is how hud and studio-037 name it. Every field is optional, so a session without a review reads as before."
rejected:
  - option: "b"
    why: "hud#703 and studio-037 settled on the session kind, and a second kind would repeat its seal, attendance and close."
  - option: "c"
    why: "An answer is not a verdict on a record and must not count toward a quorum, and an agenda item can't carry an anchor or replies."
  - option: "d"
    why: "studio-038 chose one record per batch, since a batch is sent, answered and kept together."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3350, the session kind can't hold a UI review"
    url: "https://github.com/INTENTIUS/chant/issues/3350"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#703, where a comment-mode review is kept (D8)"
    url: "https://github.com/arugula-salad/hud/issues/703"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#729, unwind durable facts from .hud/events.db"
    url: "https://github.com/arugula-salad/hud/issues/729"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-074, The repo is the database"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-074-the-repo-is-the-database.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-082, Design record kinds: contract, evidence, driver and one session kind"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-082-design-record-kinds-contract-evidence-driver-and.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3350"
  - "INTENTIUS/chant#3148"
  - "arugula-salad/hud#703"
  - "arugula-salad/hud#729"
  - "arugula-salad/hud#730"
  - "ws-074"
  - "ws-082"
  - "path:reference-workspace/design/sessions"
---

# A UI review batch is a session
