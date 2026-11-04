# Pull requests on GitHub: what's left

Done work goes to GitHub as a pull request once you approve it, and its checks come back as evidence ([docs/ship.md](../ship.md)). This is option B, decided on 2026-11-04: the loop pushes with a narrow identity of its own, after you say so. Still to do:

- **Your repository.** Create the App or machine user and the rulesets, then run `ship test` against the real repository. Done in the office.
- **A clash in the copy.** Today a base change that clashes with work in the copy is noted and left. It could become a question for you, or a todo to bring the copy up to date.
- **The token in Credential Manager.** Instead of a user environment variable: a small script that stores it, and the loop reading it from there.
- **Copilot coding agent, kept in reserve.** The work as an issue that the coding agent turns into a pull request in the cloud, with nothing able to push from this PC.
