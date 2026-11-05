# What's left after a turn is thrown away

In the first private engagement, the game's build todos failed their checks five times. A retry is now told why the last try was thrown away, and every turn is told which checks it must pass. Still to do:

- **A failed attempt's work is thrown away**, so the retry writes everything again from nothing. Consider keeping it on a branch the retry can read or start from. Work is discarded so a red line (a shaming word, a trademark) never reaches `main`. A branch only the next attempt reads doesn't break that.
- **A turn can break checks that only other todos run.** The levels todo runs only the `levels` check. It merged five levels that broke two of the core's tests, and the next build todo used up its tries on them. Consider also running the checks of every todo whose scope covers the files a turn changed.
