# Repository Guidelines

## UI/UX

1. **Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**
2. Put yourself in the shoes of a non-tech-savvy user. Can they complete the core flow and get what they need? Identify every point where they get stuck, where things feel unexplained, or where transitions between steps aren't seamless—then fix them all so the product is completely intuitive without documentation. Add short tooltips or hints only as an absolute last resort.
3. Every line of copy should read like how a native speaker actually talks. Choose words intentionally rather than translating word-for-word.
4. Whenever you display a number, make sure its meaning is instantly recognizable and easy to parse.
5. Keep buttons, spacing, corner radii, dividers, modals, motion, and shadows consistent and restrained so they never distract.Reserve shadows exclusively for truly elevated elements like modals, and never nest cards inside cards.

## Behavioral guidelines

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.
