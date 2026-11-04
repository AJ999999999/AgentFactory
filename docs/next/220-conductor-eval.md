# Decide whether the conductor is on by default

The conductor ([docs/conductor.md](../conductor.md)) is built and off by default. Run it against arm B on Copilot:

```bash
npm run eval -- --arms B,E --runs 2
```

- **Turn it on by default** if E scores higher, or the same with fewer turns redone, for a premium-request cost you accept. B scored 0.99 on Copilot (see 010); the room to improve is multi-currency, where part of the feature went undone.
- **Read its send-backs** with `npm run harness -- escalation` in each E run. A lane it often sends back points at that lane's profile or its contracts: fix the cause there.
- **Try it on a real engagement** that went the wrong way early. The turns' logs show whether it would have caught it.
