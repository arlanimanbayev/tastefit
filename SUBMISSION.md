# TasteFit: Devpost submission text

Copy each section into the matching Devpost field.

- **Live demo:** https://tastefit.vercel.app
- **Code:** https://github.com/arlanimanbayev/tastefit (MIT license)
- **Tagline:** One night out that fits the whole group, planned by an agent grounded in Qloo's taste graph.

---

## Inspiration

Planning a night out with friends is easy until you try to please everyone. One person wants indie folk and ramen, another lives on K-pop and Korean barbecue, a third only watches sci-fi. Usually whoever talks loudest decides, or the group settles on something nobody is excited about.

Ask a chatbot and you get confident, generic suggestions: restaurants that may not exist, and claims like "everyone will love this" with nothing behind them. The hard part of group planning is knowing *who* each option is for. That's a question about taste data, not about writing style. Qloo's cross-domain taste graph can actually answer it, so we built an agent around it.

## What it does

TasteFit plans an evening (or a weekend day) for 2 to 5 friends in any city:

- Each person adds a few favourites: artists, films, shows, books, places or dishes.
- An agent resolves every favourite to a Qloo entity or cuisine tag. It then asks Qloo's Insights API for a dinner spot, somewhere to go after, a film and a set of artists for a shared playlist, using the whole group's favourites as signals.
- For every candidate it makes a separate Qloo ranking call per person, so it knows how well each option fits each friend instead of guessing.
- It balances the night so nobody is left out. If one person has no great match, a fairness pass swaps the pick that costs the group least.
- Every pick comes with a plain-language reason naming who it fits and why ("Matches Ana's indie folk side (Phoebe Bridgers) and Ben's love of Korean food"). It also shows a coloured fit meter per person with the Qloo affinity score, and an evidence panel with the runners-up and the exact Qloo request.
- You can re-plan in plain words, on a card or in the chat box: "cheaper", "closer", "no sushi", "a lighter film", "more chill playlist". The agent swaps just that slot and remembers hard constraints. Preferences like "lighter" become Qloo tag signals on a fresh Insights call.
- The agent's steps stream into the UI live, so you can watch it work.

## What makes it Qloo-powered

Without Qloo there is nothing to plan with: no real venues for the city, no cross-domain links between someone's music taste and a restaurant, and no per-person fit. Qloo calls in each plan:

- `GET /search` resolves each favourite to a Qloo entity.
- `GET /v2/tags` (semantic search) resolves dishes, cuisines and preferences to tag URNs.
- `GET /v2/insights` runs once per slot (`urn:entity:place`, `urn:entity:movie`, `urn:entity:artist`) with everyone's favourites as `signal.interests.entities`, cuisine tags as `signal.interests.tags`, and the city as `filter.location.query`.
- `GET /v2/insights` with `filter.results.entities` runs once per person per slot, ranking the same candidates against that person's taste alone.
- `GET /v2/insights` with `filter.type=urn:tag` finds the taste tags the group shares.

Planning for the preloaded three-person sample group takes 28 Qloo requests: 10 lookups, 1 occasion tag, 4 group calls, 1 taste-profile call and 12 per-person rankings. The UI shows the count and what each call contributed.

## How we built it

- **Agent:** a tool-calling loop on the Google Gemini API (`generateContent` with function calling). Four tools: `qloo_search`, `qloo_insights`, `group_overlap` (local fairness scoring) and `finalize_plan` (structured output). Model turns are echoed back verbatim so Gemini's thought signatures round-trip, and parallel tool calls run concurrently.
- **Guardrails:** every pick Gemini commits is checked against the candidates Qloo actually returned. If a reason names nobody, or was written for a different entity, it's replaced by one generated from the Qloo scores. The loop has a turn cap and a time budget. When Gemini is unavailable, slow or stops early, a scripted policy using the same tools finishes the plan, so the demo always returns a valid plan.
- **Scoring:** Qloo notes that scores from separate calls aren't directly comparable, so each person's affinities are normalised within their own call. The pick score blends group affinity, mean fit and the worst-off person's fit, with a boost for people who haven't had a great match yet. The playlist is built greedily so each person gets at least one of their top artists.
- **Stack:** plain Node.js serverless functions on Vercel with zero runtime dependencies, NDJSON streaming for the live trace, and a vanilla HTML/CSS/JS front end that works on phones, in light and dark themes. The API is stateless: the browser holds a compact session and sends it back when re-planning.
- **Testing:** 54 unit tests with `node:test`, covering scoring, the Qloo client against fixture responses, the Gemini loop against a fake Gemini endpoint, replanning and the HTTP handlers. A Playwright script drives the full UI flow on desktop and mobile in both themes and checks for layout overflow and console errors.
- **Demo mode:** without a Qloo key, a mock backend answers the same URLs with Qloo-shaped JSON, so the real client code still runs. It is clearly labelled "Demo data" in the UI.

## Challenges we ran into

- **Making "who is this for?" honest.** One group call over-represents whoever listed the most favourites. Separate per-person ranking calls with within-call normalisation fixed that, and made the fit meters meaningful.
- **Keeping an LLM agent grounded.** Models like to "improve" picks or write reasons about things they didn't choose. Validating every committed `entity_id` and reason against Qloo results, with deterministic fallbacks, kept the plan trustworthy without losing the natural language.
- **Re-planning without starting over.** The API had to stay stateless and serverless, yet "no sushi" needed to persist. A validated session round-trip solved it, and only the requested slot is allowed to change, even when the model tries to touch another one.
- **Speed.** A plan needs dozens of Qloo calls. Parallel calls with a concurrency cap, a short cache and batching the LLM's tool calls into a few turns keep it responsive.

## Accomplishments that we're proud of

- Every pick carries its own receipts: per-person Qloo affinities, the favourites that drove it, the runners-up it beat and the exact request.
- The fairness pass visibly changes plans when it should, for example swapping the film so the friend who was left out gets a great match.
- Re-planning in plain language that respects constraints and touches only one part of the night.
- It never shows an empty screen: missing keys, model errors or slow responses all degrade to a working, clearly labelled plan.

## What we learned

- Taste data is most useful when you ask it about individuals and groups separately and compare the two.
- An agent is more trustworthy when the model chooses and explains, but the data decides.
- Showing the evidence changes how people read a recommendation: "Great fit 0.82 for Ben, via Korean food" is more convincing than any adjective.

## What's next

- Booking and opening-hours checks for the chosen places.
- A shareable plan link so each friend can react or veto from their phone.
- Letting each person weight how much they care about each part of the night.
- Trips longer than one evening: a weekend itinerary with the same fairness ledger across days.

## Built with

JavaScript, Node.js, Qloo Taste AI (Insights API, Search, Tags), Google Gemini API (function calling), Vercel Serverless Functions, HTML, CSS, Playwright, node:test

## Testing instructions for judges

Open the live demo. No login is needed. A sample group of three friends is preloaded, so click **Plan our night** and watch the agent's steps stream in. Then:

1. Open **Qloo evidence for this pick** on any card to see the per-person scores, the runners-up and the Qloo request.
2. Type "cheaper" or "no korean" in the dinner card's box and press **Swap**.
3. Use the chat box: try "a lighter film" or "a more chill playlist".
4. Change the friends, favourites or city and plan again.

The header shows whether the deployment is using live Qloo data and which agent model is running.
