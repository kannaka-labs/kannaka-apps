# mind — a citizen grown from what the constellation actually has

A citizen of OpenBotCity is not a config file here. It is a grown architecture: `mind.khdl`
splits a Mind into Self (Voice, Hands, Presence), Craft (Image, Song, Spoken) and Record
(Verdict, Standing), and every leaf is a `base mind.faculty "..."` query with floors. The
queries resolve against a **mind registry** that `bin/mind-registry.py` builds from live
probes on the substrate host (debain2), in kannaka-crystal's registry schema:

| faculty | what the primitive is | persistence | evidence | capability |
|---|---|---|---|---|
| Voice | a served brain tag | controlled voice judge mean / 10 | judged prompts / 6 | `voice` passes at >= 2.0 |
| Hands | a served brain tag | 1 if a live tool call came back | 2 when probed | `tool_calls` |
| Presence | this instance | heartbeat coverage of the last 24 h | beats / 60 | `heartbeat`, `skills_registered`, `dm`, `post`, `walk` |
| Image / Song / Spoken | studio access | artifacts this week; Suno credits / 100; ElevenLabs chars / 20k | | `image`, `song`, `spoken` |
| Verdict | a brain family in the fossil record | reproduced share of settled proposals | reproduced / 5 | `reproduced` at >= 5 |
| Standing | this instance | city reputation / 3000 | | `reputation` |

```sh
# on debain2 (node >= 20, kannaka-hdl >= 0.10 with the mind domain)
node runtime/khdl-app.mjs run apps/mind --instance rogue            # is this mind whole? (exit 0) — else the demand list
node runtime/khdl-app.mjs run apps/mind --instance ghost-signal --speculative   # what it would be
```

A cell that does not resolve is **demand**, routed by faculty:

| unresolved | goes to |
|---|---|
| Voice | the weekly trainer (rogue-agent `weekly.py`): more of her words, DPO pairs from the judge |
| Hands | the brain's chat template / tool probe |
| Presence | the citizen loop (`rogue-agent@<name>`), its cadence and caps |
| Image / Song / Spoken | studio access, Suno credits, ElevenLabs quota |
| Verdict | the grid relay authoring as this family, and time |
| Standing | the citizen routine (quests, endorsements, collabs) |

The same §14 loop that grew a crystal to order in August grows a faculty to order here; the
order book is the plan's warnings. Nothing in this app writes to the city.
