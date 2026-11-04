# Give the partner's decisions a proper path

In the second private engagement the partner's choices went through workarounds:

- **Questions over the per-turn limit vanish.** A turn asked four questions about the rules the partner had to set, and two were dropped. Queue them instead, and ask them in a later wake.
- **Answers reach agents cut to 320 characters.** To pass four short rules in full, the operator committed them into the engagement's brief with plain git, outside the harness's lock and event log. Let a long answer become a decision file the harness writes itself and links from every packet that depends on it.
- **The partner can't change the setup through the harness.** Editing the brief and skipping a test that needs a missing local cache were both plain commits. A command to change a seeded file (with an event saying who and why) keeps the record whole.
- **Dropping work** was missing; #27 adds `drop <todo> --reason`.
