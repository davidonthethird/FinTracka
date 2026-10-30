# Mobile Flow Full-Width Design

## Intent

Give the mobile financial-flow chart the maximum useful screen area. The FinTracka header and chart controls should remain easy to reach at the top, then leave the screen naturally as the user scrolls into the flow.

## Selected approach

Use normal document scrolling rather than JavaScript scroll-direction tracking. On mobile, remove sticky positioning from the viewer header and flow toolbar. Make the Reports flow section full-bleed by escaping the page gutters, removing its outer card border/background, and removing the chart wrapper padding. Keep the flow layout's existing small internal margin so cards and ribbons never touch the screen edge.

## Alternatives considered

- Automatic hide/reveal on scroll: rejected because it adds state, motion, and iPhone Safari edge cases without improving access once the controls naturally scroll away.
- Keep the sticky controls but collapse them: rejected because it still reserves screen space over the chart and adds another interaction.

## Constraints

- Apply the full-bleed treatment only below the existing 1000px mobile-flow breakpoint.
- Preserve desktop/tablet Sankey layout and its surrounding report card.
- Preserve all existing controls, keyboard access, fullscreen behavior, and bottom navigation.
- Do not introduce horizontal page scrolling.

## Verification

- At 320, 375, 390, 430, and 768px, the header and toolbar scroll out of view and the chart reaches the viewport edges except for its internal node margin.
- The page has no horizontal overflow.
- At 1000px and above, the existing desktop Sankey remains unchanged.
