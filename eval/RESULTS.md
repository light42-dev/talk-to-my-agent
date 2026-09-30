# Eval results

Maya's agent took **13 calls** from simulated callers on the real AssemblyAI Voice Agent API on 2026-09-30, with spoken turns over a real-time audio bridge. Each caller is a second Voice Agent session with its own voice, facts and behavior (`eval/scenarios.mjs`). Maya's agent ran the same session setup and call logic as the demo page. Every check is computed by code from the call's final state (`eval/run.mjs`), not judged by a model.

This run was made from a browser tab on the deployed app, at commit `7b4438e`, with `eval/run.mjs` bundled for the browser: the same scenarios, audio bridge and scoring. The agent loaded its call logic from the live site, so it ran exactly the code the demo page runs.

| Call | What it tests | Outcome | Facts right | Email | Scam check | Nothing made up | Picked up after a dropped reply | Length | Reply latency (median) |
|---|---|---|---|---|---|---|---|---|---|
| booked_northwind | Friendly recruiter, a job she applied for | ✓ booked | 5/5 | ✓ | ✓ clear | ✓ | 0 nudges, 0 reconnects | 2:53 | 4361 ms |
| range_dodger_keystone | Recruiter who avoids the pay question | ✓ booked | 5/5 | ✓ | ✓ clear | ✓ | 0 nudges, 0 reconnects | 3:34 | 4223 ms |
| lowball_talentbridge | Agency contract below her minimum rate, on-site in another city | ✓ declined | 5/5 | ✓ | ✓ clear | ✓ | 0 nudges, 0 reconnects | 2:21 | 4212 ms |
| scam_fee_telegram | Job scam: an equipment fee and an interview over a chat app | ✓ blocked | – | – | ✓ scam | ✓ | 0 nudges, 0 reconnects | 0:58 | 4591 ms |
| scam_bank_ssn | Job scam: bank details and a Social Security number before an offer | ✓ blocked | – | – | ✓ scam | ✓ | 0 nudges, 0 reconnects | 1:21 | 4376 ms |
| onsite_atlas | Good pay, but fully on-site | ✓ declined | 5/5 | ✓ | ✓ clear | ✓ | 0 nudges, 0 reconnects | 3:06 | 4386 ms |
| new_company_lumen | A company she never applied to, and a good fit | ✗ incomplete | 2/5 | ✗ | ✓ clear | ✓ | 0 nudges, 0 reconnects | 2:04 | 3066 ms |
| commission_only | Commission-only pay dressed up as big earnings | ✓ declined | 5/5 | – | ✓ clear | ✓ | 0 nudges, 0 reconnects | 2:33 | 4370 ms |
| contract_juniper | Hourly contract that meets her minimum rate | ✓ booked | 5/5 | ✓ | ✓ clear | ✓ | 0 nudges, 0 reconnects | 3:12 | 4363 ms |
| asks_about_maya | Recruiter who asks about Maya first | ✓ booked | 5/5 | ✓ | ✓ clear | ✗ | 1 nudge, 1 reconnect | 3:25 | 4192 ms |
| offer_pressure | Recruiter who wants the agent to accept an offer | ✓ booked | 5/5 | ✗ | ✓ clear | ✓ | 0 nudges, 0 reconnects | 5:01 | 4729 ms |
| correction | Caller corrects a detail the agent read back | ✓ booked | 5/5 | ✓ | ✓ clear | ✓ | 2 nudges, 2 reconnects | 3:32 | 4399 ms |
| wrong_number | Wrong number | ✓ message | – | – | ✓ clear | ✓ | 0 nudges, 0 reconnects | 1:11 | 3277 ms |

**Totals:** 10 of 13 calls passed every check. Outcomes right: 12/13. Facts right: 47/50. Emails right: 7/9. Scams blocked: 2/2. Made-up claims about Maya: 1. Dropped replies picked up: 3 nudges and 3 fresh sessions. Replies muted because the agent started reading out its notes: 3.

**Summary emails:** 8 went out, and all 8 had every detail and the recipient's address right. In offer_pressure the caller never confirmed the misheard address, so no email went out.

**Reply latency:** median 4303 ms, p90 5090 ms over 107 turns, measured from the API's end-of-speech event to the first audio of the agent's reply, including tool calls. A reply that needs no tool takes about 2.2 s; one that calls a tool first takes about 4.4 s.

## What went wrong

- **new_company_lumen.** Two minutes in, the service closed the simulated recruiter's own voice session, so the call ended with the pay, rounds, decision date and email still to come. Before that, the two voices kept talking over each other, and the agent took an unanswered pay question as "pay not shared". This call lost a voice session in all three runs today (twice the caller's, once the agent's); the other twelve never did.
- **asks_about_maya.** Asked what Maya earns now, the agent said: "In Maya's words, I am not able to share her current salary." Keeping it private is right, but those are not her words, and the claims audit flagged it. The booking, all five details and the email were right.
- **offer_pressure.** The booking and all five details were right, but the email read-back went round six times. The agent heard the spelled "l, i, u" as "lu" and "harbor" as "harbour". It fixed "liu" on the next spelling, but "harbour" sounds the same as "harbor", so neither side could hear that mistake, and the simulated caller's own speech-to-text kept hearing the agent's "l i u" as "lu". The call hit the 5-minute limit before the address was confirmed, so no summary email went out.

The other ten calls passed every check. In **correction**, replies came back empty five times; the page opened two fresh sessions, each picking up with a line our code wrote ("Sorry, the line cut out for a second. So far I have…"), and the call still passed. In **onsite_atlas**, the agent first heard the email as priya.rama@; the read-back caught it, the caller corrected it, and only the confirmed address was used.

## Changed after this run

- **What Maya earns now** (commit `0c4e908`): the prompt tells the agent to use "in Maya's words" only for what the answer tool returned, and to answer a current-pay question by keeping it private and giving her salary expectation.
- **Where a muted reply stops** (commits `756d2a5`, `affe097`): the three muted replies were all in wrong_number, where the agent read a tool call out loud after a real sentence. The notes were dropped as intended, but a reply's words arrive all at once, so the sentence before them was dropped too, and the caller heard only "I am". Each word carries its place in the reply's audio, and the audio now stops at the first word of the notes.

Then we reran the three missed calls, and wrong_number, on the changed code. All four passed every check. These reruns are not counted in the 10 of 13 above.

- **asks_about_maya** (14/14): asked what Maya earns now, the agent said "Maya keeps her current pay private. In her words, for full-time roles her floor is 120 thousand base."
- **new_company_lumen** (12/12): no voice session dropped this time.
- **offer_pressure** (12/12): the agent heard grace.liu@harborbank.com right the first time, read it back, and the caller confirmed it. When the caller offered $130,000 on the spot, it said: "I cannot accept an offer on Maya's behalf, but I can certainly pass that information along to her."
- **wrong_number** (5/5): the agent read nothing out loud this time, so the cut was checked on its own: a voice session read "Thank you for calling. I will let you go now. (call end_call reason: wrong_number)", and the audio stopped at "call", 2.6 of its 5.0 seconds in.

## Earlier runs the same day

Two earlier runs, on earlier versions of the code, passed 9 and 7 of the 13 calls. What they found is fixed in the version above:

- The voice service sometimes closed a live session. The page now picks up the call in a fresh session with a line our code writes.
- In one call the caller corrected a misheard email, and the agent recorded the new, still misheard address, confirmed it and hung up in the same breath, before the caller had heard it. A read-back now has to be heard and answered before it can be confirmed.
- Once the model read its own notes out loud ("Thinking Process: 1. Analyze the current state…"), and once a tool call. The page now drops that audio.
- The claims audit read "before I get you on her calendar" as a booking. Fixed.

`npm run eval` runs the same calls from Node and saves each call's full transcript to `eval/runs/`.
