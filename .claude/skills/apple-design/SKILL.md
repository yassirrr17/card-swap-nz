---
name: apple-design
description: Apply Apple Human Interface Guidelines-inspired visual polish (typography, spacing, color, elevation, glass, motion) to CardSwap NZ's UI in index.html and style.css. Use this whenever the user asks to make the app feel more "Apple-like," "premium," "native," or "polished," when redesigning or restyling any screen/component, when adding a new card/button/modal/nav element, or when a UI change looks flat, cluttered, or inconsistent with the rest of the app. Also use it proactively while writing any new CSS in this repo so new styles stay consistent with the app's existing design tokens instead of introducing one-off values.
---

# Apple-style design for CardSwap NZ

CardSwap NZ is a vanilla HTML/CSS/JS app (`index.html`, `style.css`, `app.js`, no build step, no framework). This skill turns Apple HIG sensibilities into concrete rules for *this* codebase: which CSS variables to reuse, which patterns to avoid, and how to extend `:root` in `style.css` without breaking the existing navy/emerald identity.

The goal of Apple-style design here is not "add blur and rounded corners everywhere." It's restraint: one clear focal point per screen, generous whitespace, a small number of reused values (never invented one-off px/rgba numbers), and motion that confirms an action rather than decorating it. When in doubt, remove an effect rather than add one — Apple's UI reads as calm because most of it is quiet.

## 1. Always work through the existing tokens

`style.css` already defines a full token system in `:root` (lines 2-55). Before writing any new rule, check whether a token already covers it:

- **Radius** — `--radius-sm` (4px), `--radius` (8px), `--radius-lg` (12px), `--radius-xl` (16px). Apple's soft-squircle look comes from consistent, moderate radii — never use an ad hoc `border-radius: 10px` when `--radius` or `--radius-lg` already exists. Reserve `20px`+ / `50%` (already used for pills and avatars) for genuinely circular or pill-shaped elements only.
- **Elevation** — `--shadow-sm`, `--shadow`, `--shadow-md`, `--shadow-lg`, each a soft, low-opacity black shadow with a large blur radius and small offset (e.g. `0 8px 32px rgba(0,0,0,0.12)`). This is the Apple elevation model: shadows read as *depth*, not as a hard drop-shadow outline. Never add a shadow with opacity above ~0.15 or a small blur radius (that reads as Material/skeuomorphic, not Apple). Pick elevation by importance: static cards get `--shadow` or `--shadow-md`; anything overlaying the page (modals, popovers, the raised state of a hovered card) gets `--shadow-lg`.
- **Motion** — `--transition: all 0.2s ease`. Apple's UI motion is fast and eases out, not linear and not bouncy. Reuse `var(--transition)` for hover/focus/press states. If a specific interaction needs its own timing (e.g. a modal entrance), stay in the 150–300ms range with an ease-out curve (`cubic-bezier(0.16, 1, 0.3, 1)` is a good Apple-ish "ease-out-expo" if the default `ease` feels too abrupt) — don't reach for spring/bounce curves or anything over ~400ms, both read as un-Apple.
- **Color** — `--navy`/`--navy-dark`/`--navy-light` for the brand's dark tone, `--gold`/`--gold-dark`/`--gold-light` (an emerald green despite the name — see the comment at the top of `:root`, keep using these variable names, not new green vars) for primary actions, `--gray-50` through `--gray-900` for neutrals, plus semantic `--green`/`--red`/`--yellow`/`--blue` (each with a `-light` background tint) for status. Apple UI leans heavily on neutral grays with a single accent color doing all the "look here" work — resist adding new hues. If a new state needs color, first check whether one of the existing semantic pairs already fits.
- **Safe areas / tap targets** — `--safe-top/bottom/left/right` and `--tap-target: 44px` already encode Apple's own HIG minimum (44×44pt touch targets, safe-area-aware layout for notches/home indicators). Any new tappable element (button, icon button, nav item) must respect `--tap-target` as a minimum hit area, and anything pinned to a screen edge must factor in the relevant `--safe-*` var.

Read the token block once before making changes so new CSS composes with what's there instead of drifting from it.

## 2. Typography

The app already pairs `--font-heading: 'Sora', ...` with `--font-body: 'Inter', ...`, both falling back to `-apple-system, BlinkMacSystemFont` (San Francisco on Apple devices). Keep that structure:

- Headings use `var(--font-heading)`, body copy and UI text use `var(--font-body)`. Don't introduce a third family.
- Apple typography favors a tight, confident type scale with clear hierarchy and few weights in play at once (usually regular + semibold/bold, rarely more). When adding a new heading or label, match its size/weight to the nearest existing heading level in `style.css` rather than picking an arbitrary size.
- Line length and line height: body text should stay comfortably readable (roughly 1.4–1.6 line-height for paragraphs); avoid setting justified text or very tight leading on multi-line copy.
- Letter-spacing: Apple UI tightens tracking slightly on large headings and opens it slightly on small all-caps labels (e.g. section eyebrows, badges). Don't apply letter-spacing changes to body paragraphs.

## 3. Spacing and layout

Apple layouts read as uncluttered because spacing is consistent and generous, and every screen has one obvious primary action:

- Group related controls tightly, separate unrelated groups with clearly larger gaps — avoid uniform small gaps everywhere, which flattens hierarchy.
- Cards and sections should have breathing room around their content (comfortable internal padding, not text touching the card edge) and consistent gaps between siblings in a grid or list.
- Each screen/modal should have exactly one primary (`.btn-primary` / `.btn-gold`) action; secondary actions use `.btn-outline` or a plain text/icon button so they don't compete visually.
- Avoid borders as the primary way to separate content. Prefer whitespace and subtle elevation (`--shadow`) over `border: 1px solid`; reserve visible borders for input fields and places that need a crisp edge.

## 4. Glass / translucency effects

Use sparingly and only for elements that float above content — a sticky top nav, a bottom nav bar, a modal backdrop, a floating action bar. Never apply blur to a full-page background or to normal content cards; Apple reserves translucency for chrome that sits *above* scrolling content, not for the content itself.

Pattern to use when adding a new glass surface:

```css
.your-floating-element {
    background: rgba(255, 255, 255, 0.72); /* or a navy-tinted rgba for dark chrome */
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px); /* Safari/iOS requires the prefix */
    border-bottom: 1px solid rgba(0, 0, 0, 0.06); /* hairline, not a heavy border */
}
```

Always include the `-webkit-` prefix — this app targets a PWA installed on iOS/Android, where unprefixed `backdrop-filter` alone can silently no-op on Safari. Check `prefers-reduced-motion`/existing `@media (prefers-reduced-motion: reduce)` handling (already present near line 116) before adding any new animated effect, and make sure blur-heavy elements still have a solid enough background color to stay legible if `backdrop-filter` isn't supported (treat the `rgba` background as the fallback, not just a tint).

## 5. Buttons, cards, and inputs

Look at the existing `.btn`, `.btn-primary`, `.btn-outline`, `.btn-gold` and card rules in `style.css` before adding new variants — extend that naming pattern (`.btn-*`) rather than inventing a parallel one. Apple-style interactive elements:

- Have a clear, single resting state, a subtle hover/press feedback (slight elevation increase via `--shadow` → `--shadow-md`, or a slight scale/opacity change — nothing jarring), and an obvious but unobtrusive focus ring for keyboard/accessibility use.
- Use `var(--radius)` or `var(--radius-lg)` consistently across all buttons of the same size — don't mix radii within one button group.
- Icon-only buttons need an accessible label (this codebase already uses `aria-label` on icon buttons like `.modal-close` and `.mobile-menu-btn` — keep doing that) and must meet the `--tap-target` minimum even if the visible icon is smaller.
- Disabled/loading states should look clearly inactive (reduced opacity, no shadow) rather than just losing their click handler.

## 6. Dark mode

This app does not currently implement a dark theme (no `prefers-color-scheme` or `data-theme` handling in `style.css`). Do not add a parallel dark palette speculatively — only build it if the user explicitly asks for dark mode support. If asked, derive dark values from the existing token names (e.g. swap `--white`/`--gray-50` backgrounds for `--navy-dark`/`--navy`, keep the emerald `--gold` accent as-is since it already reads well on dark) inside a `@media (prefers-color-scheme: dark)` block or a `[data-theme="dark"]` attribute selector, following whichever mechanism the rest of the app's JS already expects — check `app.js` for any existing theme-toggle logic first.

## 7. Sanity check before finishing

After making a styling change, re-read the diff and ask:

1. Did I reuse an existing `--variable` everywhere one applies, instead of hardcoding a new color/radius/shadow value?
2. Is there still exactly one visually dominant element per screen/section?
3. Would this look at home next to the existing navy/emerald cards and buttons already in the app, or does it clash in hue, radius, or shadow style?
4. If I added blur or animation, does it degrade gracefully (solid fallback background, `-webkit-` prefix, respects reduced-motion)?

If the answer to any of these is "no," revise before considering the change done.
