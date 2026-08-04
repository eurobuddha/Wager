# Openly v2.3.0 — Complete Requirements

Every requirement from user testing, compiled from the full conversation.

## Brand
- App name: **Openly** (bold O and l: **O**pen**l**y)
- Flavor text: **O**pen**P**rop**L**ock
- Tagline: "Propose anything. Bet anyone. Trust no one."

## Language — ABSOLUTE RULES
- Sides: **TRUE** / **FALSE** — never YES/NO
- Propositions are STATEMENTS, not questions ("BTC above 80k by Friday")
- Post form label: "Proposition" with placeholder "e.g. BTC above 80k by Friday"
- Settlement: 'Is "[proposition]" TRUE or FALSE?'
- Cash flows: explicit numbers with 2 decimal places and "MINIMA" unit
- Market format: "TRUE 20 — FALSE 5 | in 10" (asks, not stakes)

## Market Display (the core visual)
- **Odds bar** shows WANTS (what each side asks from counter), NOT stakes
  - Example: posted 10 TRUE wanting 20, countered 5 FALSE → bar shows TRUE 20 / FALSE 5
  - When only one side exists, show stake amount + "Needs TRUE/FALSE" dashed
  - Proportional green/red pill shape
- **Meta line**: "TRUE [ask] — FALSE [ask] | in [betSize] | [count] bets"
- **NO redundant spread line** (was showing same numbers twice)
- **Position**: "You: TRUE 10 — profit 5 if right" (profit, not total pot)
- **Buttons**: "Counter FALSE" (red) / "Counter TRUE" (green) — correct colors
- **Must update after countering** — refresh triggers re-render

## Activity Log — PERSISTENT, ALWAYS VISIBLE
- **At the top**, below topbar, above main content
- **4 lines visible** (not 3) — max-height must accommodate 4 full rows
- Scrollable for history
- Timestamped, newest first
- Toasts for urgent events (proposals) as SUPPLEMENT, not replacement
- **Log tab** is a main nav tab — NOT hidden in More menu

## Navigation — 5 tabs, NO EMOJI
- Markets | Post | My Bets | Log | More
- SVG line icons only — no emoji characters anywhere in nav
- More contains: Arbiter, History

## Layout — CENTERED, RESPONSIVE
- Mobile: single column, content centered
- Topbar, log panel, main content all have consistent width
- **Desktop 768px+**: content centered with max-width, not left-aligned
- **Desktop 1024px+**: 2-column grid for market cards
- **Post form**: max-width 560px, centered
- **Cards**: centered within their container
- **No content hugging left edge on wide screens**

## Empty States
- Plain grey text: "No active markets — post the first"
- **NO emoji icons** anywhere except onboarding slides

## Post Form
- Label: "Proposition"
- Side: TRUE / FALSE toggle
- Your Bet / They Must Bet
- Live preview with cash flows (If TRUE: +X / If FALSE: -Y / Locked: Z)
- Arbiter fields (pk, addr, mx key)
- **Timeout**: presets (1500, 3000, 5000, 10000) + custom block count input
- Button: "Post Proposition"

## Counter / Take Bet Sheet
- Bottom sheet with pill handle
- Shows proposition, market state ("TRUE 20 — FALSE 5")
- Big number display for slider value — clean integers, no trailing .01
- **Slider step**: integer steps for spreads > 1, 0.01 for small spreads
- **Slider min**: 0.01 (not 0.1)
- Live cash flow preview: "You stake (FALSE) 5.00 MINIMA / Against (TRUE) 10.00 MINIMA / If FALSE +10.00 / If TRUE -5.00"
- Button text changes: "Post counter — 5M" vs "Take their bet — 10M"
- Cancel button below

## Matched Bet (My Bets)
- Status: LIVE with pulse animation
- Shows: proposition, your side (TRUE/FALSE), stakes, cash flows
- **Settlement**: 'Is "[proposition]" TRUE or FALSE?' with TRUE/FALSE/Void buttons
- **Proposal**: purple card "Counterparty says: TRUE" with Agree/Disagree
- **Chat**: inline, scrollable, always visible
- **Patience messaging**: "Confirming on-chain — ~1 minute"

## Arbiter
- Gold-bordered card
- Shows proposition, both sides' stakes (.toFixed(2)), fee
- TRUE / FALSE buttons

## Cancelled Bets
- Greyed out, unclickable until confirmed off-chain
- "Cancelling..." status text

## Onboarding (3 slides)
- Slide 1: "No house. No middleman. No loophole." (dark red theme)
- Slide 2: "Skin in the game." + arbiter/escrow copy (dark green theme)
- Slide 3: "Propose anything. Bet anyone. Trust no one." (dark purple theme)
- Brand: **O**pen**l**y + **O**pen**P**rop**L**ock
- Stored in keypair, shown once

## CSS Variables
- `--true` / `--true-soft` (not --yes)
- `--false` / `--false-soft` (not --no)
- Button classes: btn--yes/btn--no still work (mapped to --true/--false)

## What NOT to do
- No emoji in nav or empty states
- No YES/NO language
- No auto-dismissing toasts as primary feedback
- No single-column desktop
- No left-aligned content on wide screens
- No "Post Question" (it's "Post Proposition")
- No broken cash flow math
- No trailing .01 on slider values
