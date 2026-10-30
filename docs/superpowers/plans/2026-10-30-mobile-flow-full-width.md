# Mobile Flow Full-Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the mobile viewer header and flow controls scroll away while the financial-flow canvas uses the full available content width.

**Architecture:** Keep the existing React hierarchy and flow layout engine. Add a Reports-only page hook and responsive CSS that removes the mobile flow card/gutters, while retaining the existing desktop Sankey treatment at 1000px and above.

**Tech Stack:** React 19, TypeScript, CSS, Playwright, Vitest

**Spec:** `docs/superpowers/specs/2026-10-30-mobile-flow-full-width-design.md`

## Global Constraints

- Use normal document scrolling; add no scroll-direction JavaScript.
- Apply the full-bleed flow treatment only below 1000px.
- Preserve controls, accessibility, fullscreen, bottom navigation, and desktop Sankey behavior.
- Keep the chart's existing internal eight-pixel layout margin and prevent horizontal overflow.

## Review Focus

- iPhone widths: header and controls must leave the viewport after scrolling.
- 768–999px widths: the flow must fill the workspace beside the fixed navigation without overflowing.
- Fullscreen: controls must remain reachable even though they are non-sticky in normal page flow.
- 1000px and wider: desktop Sankey/card spacing must remain unchanged.
- Long expanded flows: no new horizontal page scroll or clipped cards.

---

### Task 1: Full-width mobile flow and scroll-away chrome

**Files:**
- Modify: `frontend/src/viewer/ReportsPage.tsx`
- Modify: `frontend/src/viewer/viewer.css`
- Modify: `frontend/e2e/remote-viewer.spec.ts`
- Test: `frontend/tests/viewer-pages.test.tsx`

**Interfaces:**
- Consumes: existing `.viewer-page`, `.report-flow-section`, `.report-flow-map`, `.mobile-flow-toolbar`, and fullscreen classes.
- Produces: a `reports-view` page class used only as a responsive layout hook.

- [x] **Step 1: Write failing layout tests**

Add assertions that Reports renders `viewer-page reports-view`. In Playwright, assert at mobile widths that the flow map shares the workspace's left/right bounds, the page has no horizontal overflow, and both `.viewer-topbar` and `.mobile-flow-toolbar` have scrolled above the viewport after scrolling into the chart. Retain the existing 1280px desktop Sankey assertion.

- [x] **Step 2: Run tests and confirm the old sticky/gutter layout fails**

Run: `npm --prefix frontend test -- tests/viewer-pages.test.tsx && npm --prefix frontend run test:e2e -- e2e/remote-viewer.spec.ts`

Expected: the new page-class assertion fails first; after that test is satisfied but before CSS changes, the mobile edge and scroll-away assertions fail.

- [x] **Step 3: Implement the minimal responsive layout**

Add `reports-view` to the Reports root. Make `.viewer-topbar` and the normal `.mobile-flow-toolbar` non-sticky. Below 1000px, break `.report-flow-section` out of the current page gutters, remove its card border/background, remove `.report-flow-map` padding, and retain padding only on the section heading and controls. Restore sticky controls inside fullscreen and restore the existing report card/padding at the 1000px desktop breakpoint.

- [x] **Step 4: Run focused verification**

Run: `npm --prefix frontend run typecheck:viewer && npm --prefix frontend test -- tests/viewer-pages.test.tsx tests/mobile-expandable-sankey.test.tsx && npm --prefix frontend run test:e2e -- e2e/remote-viewer.spec.ts`

Expected: all focused checks pass at 320, 375, 390, 430, 768, and 1280px.

- [x] **Step 5: Run full verification and commit**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build && npm --prefix frontend run test:e2e`

Expected: all checks pass and the production build succeeds.

Commit:

```bash
git add docs/superpowers/specs/2026-10-30-mobile-flow-full-width-design.md docs/superpowers/plans/2026-10-30-mobile-flow-full-width.md frontend/src/viewer/ReportsPage.tsx frontend/src/viewer/viewer.css frontend/tests/viewer-pages.test.tsx frontend/e2e/remote-viewer.spec.ts
git commit -m "fix: give mobile financial flow full width"
```
