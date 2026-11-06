# Quiz: what does AgentFactory do?

Answer each question with one letter, or NULL if your evidence does not let you decide.

1. When a Jira bug comes in, what happens first?
   A) A worker agent starts writing the fix right away
   B) A strong model triages it: which service, what to search the logs for
   C) The human is paged to look at it
   D) It is closed as a duplicate

2. What must exist before the fix is written?
   A) A design document
   B) A rollback plan
   C) The human's approval of the fix
   D) A test that fails because of the bug

3. Who merges the pull request?
   A) The agent that wrote the fix
   B) The reviewing model
   C) The human, by approving it
   D) Nobody: it merges by itself when the checks pass

4. What does the "conductor" do?
   A) A strong model reads finished work and accepts it or sends it back
   B) Schedules which agent runs next
   C) Writes the code
   D) Talks to the person who reported the bug

5. How does the reply to the person who reported the bug get sent?
   A) The agent posts it as soon as it is written
   B) Support staff write it by hand
   C) It is drafted, and sent only when the human says Send
   D) No reply is sent

6. What does ticking "from now on" do?
   A) Pauses the work
   B) Closes the ticket
   C) Raises the budget
   D) Makes the human's answer a rule for the same question next time

7. Where is every event and answer recorded?
   A) An append-only log kept in git
   B) A cloud database
   C) Slack's message history
   D) Nowhere; only the code is kept

8. The review on the pull request is:
   A) An approval by the same model that wrote the code
   B) Skipped when the tests pass
   C) By a different model, posted as a comment rather than an approval
   D) Done by the person who reported the bug

9. How many humans does the firm need?
   A) One per agent
   B) A team lead for each service
   C) One partner, who makes the calls
   D) None at all

10. Who gathers the logs for a bug?
   A) A job the harness runs, not an agent turn
   B) The human
   C) The person who reported the bug
   D) The conductor
