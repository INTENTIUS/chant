---
schema: 1
id: "ws-091"
title: "Ad-hoc decision points whose candidates come with the ask"
state: "decided"
area: "D20"
source:
  issue: "INTENTIUS/chant#3403"
  row: "points: ask an ad-hoc question whose candidates come with the ask"
  revision: null
question: "An agent working with people asks them questions it makes up as it goes, with options of its own (hud's hud_ask and AskUserQuestion), and acts on the one a person picks. arugula-salad/hud#813 wants each such question and its answer kept in the repo as a decision point, written through chant (ws-074). points ask only works for a point a points file declares, with its candidates fixed there, points answer refuses any answer outside them, and hud does not own the workspace's declaration. How does a workspace let a caller ask a question whose text and candidates arrive with the ask, and keep them so the answer is still checked?"
options:
  - id: "a"
    label: "an ad-hoc point kind whose question and candidates come with each ask and are kept in the record"
    how: "A point in the points file declares adhoc: true. Its question gives a type and instructions, what the asks are for, and no criteria, and its chain is one quorum, since no table row or model can know candidates that arrive with the ask. chant workspace points ask <point> --inputs <file|-|json> --candidates <file|-|json> takes { question, criteria }, criteria in the shape of the point's question type as a declaration's are. The answer record keeps them as asked, its candidates come from them and its title is the question's text, and they are part of the inputs hash, so the same ask is one question and other options are another. points answer checks the answer against the candidates the question was asked with, and points retract works as for any answer. An ad-hoc point asked without --candidates, a declared point given them, or candidates that don't fit are point-candidates-invalid, and a workspace whose point-answer.schema.json copy has no asked field refuses an ad-hoc ask with answer-field-unsupported. points --json lists the point with adhoc: true and each question with asked. The reference workspace declares one, agent-question, over a new point input, ask: the asker's own id for the ask and who asked. --inputs also takes the JSON itself, so a caller can give the inputs on the command line and the candidates on standard input."
    tradeoff: "The agent's own question and options are kept word for word and the answer is validated against them, through the record kind, verbs and read output a reader already uses. The cost is a second shape of point: one whose candidates are data in each record rather than the declaration, so the declaration alone no longer says every answer a point can have, and only people decide it."
  - id: "b"
    label: "the workspace declares one fixed generic point and the reader maps the agent's options onto it"
    how: "A point such as agent-question with fixed candidates (option-1 to option-n, or yes and no) is declared once, and hud translates each agent question onto it, keeping the agent's text in the subject or a note."
    tradeoff: "Nothing changes in chant. The agent's options are lost or squeezed into fixed slots, the answer is checked against slot names rather than what was offered, and the question's text lives outside the fields a reader lists."
  - id: "c"
    label: "hud declares a point per question at runtime by editing the points file"
    how: "Each agent question becomes a new point in the points file, written before the ask."
    tradeoff: "Every question changes the declaration, and every earlier answer to a reworded question warns as answer-point-changed. hud would also write a file it does not own."
choice:
  option: "a"
  reason: "lex00 chose it for #3403: the agent's own question and options are what the person answered, so the record keeps them and the answer is checked against them, and hud writes through the same points ask and points answer it already uses. Declaring the point adhoc keeps the workspace in charge of whether such questions are allowed, who answers them and the inputs that tell two asks apart, without hud touching the declaration. Restricting the chain to one quorum keeps ws-058's rule that a table row and a model answer only within the declared candidates, and a model never answers an agent's question for the people it was put to. Putting the question and candidates in the inputs hash keeps answered-once (ws-058) and the record id scheme, and refusing an ask a schema copy cannot hold follows ws-074 and ws-084: the question an agent asked is not dropped silently."
rejected:
  - option: "b"
    why: "It loses the agent's own options, and the answer is validated against slot names rather than what was offered."
  - option: "c"
    why: "Every question rewrites the declaration, which hud does not own, and earlier answers warn as changed."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#3403, points: ask an ad-hoc question whose candidates come with the ask"
    url: "https://github.com/INTENTIUS/chant/issues/3403"
    as_of: "2026-10-03T00:00:00Z"
  - title: "arugula-salad/hud#813, an agent's question to the room becomes a decision point, and the answer is written through chant"
    url: "https://github.com/arugula-salad/hud/issues/813"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-058, decision points"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-058-decision-points.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-074, the repo is the database"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-074-the-repo-is-the-database.md"
    as_of: "2026-10-03T00:00:00Z"
  - title: "ws-084, retracting a decision point answer"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-084-retracting-a-decision-point-answer.md"
    as_of: "2026-10-03T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-03"
reviews: []
constrains:
  - "INTENTIUS/chant#3403"
  - "arugula-salad/hud#813"
  - "ws-058"
  - "ws-074"
  - "ws-084"
  - "path:packages/core/src/workspace/points.ts"
  - "path:packages/core/src/workspace/decide.ts"
  - "path:packages/core/src/workspace/decision-points.schema.json"
  - "path:packages/core/src/workspace/point-answer.schema.json"
  - "path:reference-workspace/decisions/points.json"
---

# Ad-hoc decision points whose candidates come with the ask

How to declare an ad-hoc point is in [Decision Points](https://intentius.io/chant/guide/decision-points/#ad-hoc-points), and `points ask --candidates` in [chant workspace points](https://intentius.io/chant/cli/workspace-points/#asking-an-ad-hoc-question).
