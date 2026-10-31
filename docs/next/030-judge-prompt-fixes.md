# Fix what the first judge turn showed in the prompt

The validator dropped two parts of the reply:
- a finding that cited `repo:handoff-packet`, which isn't a file
- a proposed `job` with no spec

Say in `turnPrompt` what a valid source is and what a job needs, or steer agents to propose a `task` or an `action` instead.
