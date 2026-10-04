---
schema: 1
id: "ws-084"
title: "Retracting a decision point answer"
state: "decided"
area: "D20"
source:
  issue: "INTENTIUS/chant#3351"
  row: "Decision points for hud's intent walk, a note on points answer, and clearing an answer"
  revision: null
question: "hud's intent walk keeps a person's answer per region and node, with a note, and lets the person clear it (arugula-salad/hud#729 moves these answers into the repo through chant). chant's answer records are written once and never change: answered is a closed state, and points answer refuses an answered question with record-closed. How does a person take an answer back, or change it, through chant, so that the record still says what was answered before, and how do the walk's three questions and the note fit the answer kind?"
options:
  - id: "a"
    label: "points retract escalates the question again and keeps the answer in the record's retractions"
    how: "chant workspace points retract <id> --by <name>... [--note <why>] needs the point's quorum, counted as for an answer, and is refused in a steward's turn. The record goes back to escalated with the point's quorum as its decider. The answer, its decider, answered_by, answered_on and its note (as answer_note) move into a retractions list with by, on and note for the retraction, oldest first; a confirmed model proposal goes back into escalations. people answer again with points answer, and asking the point again returns the retracted question unchanged, since people took it back from the deciders. points answer gains --note, kept as the record's note. Both fields are in point-answer.schema.json; a workspace copy without them refuses a note or a retraction with answer-field-unsupported rather than drop it. The reference workspace declares the walk's questions as three quorum-only points, intent-origin, intent-judgment and intent-disposition, over region.id and node.id, with node a new point input naming any node of graph --intent."
    tradeoff: "One record per question keeps the answered-once rule and the id hud already reads, and the history is in the record a reader already lists. The cost is that answered stops meaning never changes again: a record kind's closed state is reopened, by a points verb and only with the history kept, and a change of mind takes two writes, retract then answer."
  - id: "b"
    label: "points answer --replace overwrites the answer and appends the old one to a history field"
    how: "An answered question takes a second answer under the quorum; the first moves into history."
    tradeoff: "One write for a change of mind. It leaves no way to clear an answer without giving another, which is what hud's walk does when a person unticks one, and a replaced answer is never open, so a reader listing open questions never sees it."
  - id: "c"
    label: "a retraction is a new record that supersedes the answer"
    how: "points retract writes a retraction record linked to the answer by supersedes, and the question is asked anew under a fresh id."
    tradeoff: "Records stay immutable. The id is the point and the inputs hash, so a fresh answer needs a new id scheme or a salt, every reader has to follow the chain to find the current answer, and hud's per region and node lookup breaks."
  - id: "d"
    label: "hud declares the walk's points and keeps clearing in its own store"
    how: "chant adds only --note; hud deletes its cached answer and asks again."
    tradeoff: "Nothing changes in chant's answer rule. A cleared answer then lives outside the repo, which ws-074 rules out, and the record still shows the cleared answer as answered."
choice:
  option: "a"
  reason: "ws-074 needs the clear to be a fact in the repo, and option a keeps it in the record a reader already reads, under the id hud already joins on, without a new kind. Escalating rather than deleting means points --open shows the question again, and the retractions say what was answered, by whom and why it was taken back. Counting the quorum and refusing a steward's turn keep the same rule for taking an answer back as for giving one (#2749). Refusing a note the schema copy cannot hold follows ws-074: a person's words are not dropped silently, unlike a model's reason (#3345), which the record never depended on. Declaring the three questions in the reference workspace, rather than in hud, gives a workspace a copy to adopt; a workspace with other answer sets declares its own points over the same inputs. The node input is additive and leaves #3403's ad-hoc points, whose candidates arrive with the ask, open: the record already carries the candidates it was asked with."
rejected:
  - option: "b"
    why: "It can't clear an answer, and a replaced question never shows as open."
  - option: "c"
    why: "The answered-once id breaks, and every reader follows a chain to find the current answer."
  - option: "d"
    why: "A cleared answer would live outside the repo (ws-074)."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3351, decision points for hud's intent walk, a note on points answer, and clearing an answer"
    url: "https://github.com/INTENTIUS/chant/issues/3351"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#729, unwind durable facts from .hud/events.db into the repo"
    url: "https://github.com/arugula-salad/hud/issues/729"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-058, decision points"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-058-decision-points.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-074, the repo is the database"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-074-the-repo-is-the-database.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "INTENTIUS/chant#3403, ad-hoc points whose candidates arrive with the ask"
    url: "https://github.com/INTENTIUS/chant/issues/3403"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3351"
  - "arugula-salad/hud#729"
  - "ws-058"
  - "ws-074"
  - "path:packages/core/src/workspace/decide.ts"
  - "path:packages/core/src/workspace/point-answer.schema.json"
  - "path:reference-workspace/decisions/points.json"
---

# Retracting a decision point answer

`points retract` and the note on an answer are described in [chant workspace points](https://intentius.io/chant/cli/workspace-points/#retracting-an-answer), and the intent walk's three points in [Decision Points](https://intentius.io/chant/guide/decision-points/#the-intent-walks-questions).
