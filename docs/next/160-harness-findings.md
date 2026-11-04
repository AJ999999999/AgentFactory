# Record what goes wrong with the harness itself, as typed findings

The Observator → Solver → Evaluator loop only looks for work built on outdated inputs. It doesn't see harness runs, so every harness fix so far came from an operator reading turn logs by hand. Each problem in the second private engagement left a signal a program could read:

| What happened | The signal |
|---|---|
| A turn thrown away for a test that also failed on the starting commit | A check failure on code the turn never touched |
| Turns proposing tasks that were already planned, under new probation roles | A new lane, with text close to an open todo's |
| An agent running `python ...` six times, refused each time, and never `npm test` | The same refusal repeated within one turn |
| Two of four questions to the partner silently dropped | The per-turn question limit was hit |

Record each as a finding about the harness, kept apart from the engagement's beliefs, with the symptom, the turn, and how often it has happened across engagements. Today this lives in prose (`docs/real-runs.md`, the operator's private notes). Typed records give the loop something to work from: counted, ranked, and checked again after a fix.
