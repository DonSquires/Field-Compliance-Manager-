-- UI/UX review checklist for Bob Builder and Vibe is data, not code
-- (owner direction 2026-11-12: "add this skill to vibe builder and bob builder and visual code studio
-- and yourself: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill").
--
-- One platform knowledge card, written for this repository in our own words and adapted from the
-- UI UX Pro Max skill (github.com/nextlevelbuilder/ui-ux-pro-max-skill, MIT licence, Next Level Builder).
-- The full skill, with its local search tool and catalogue, is vendored for editors at
-- .claude/skills/ui-ux-pro-max. Builder chat and Vibe find the card through their knowledge tool by tag.
-- It is deliberately not tagged independent_code_review: a backend-only change must not be pushed
-- through a UI review. Idempotent: inserted only when no active global card owns the key.

INSERT INTO public.bob_knowledge_cards
  (organization_id, category, key, title, content, tags, source, is_active)
SELECT NULL, card.category, card.key, card.title, card.content, card.tags,
  'migration:20261112110000_builder_ui_ux_pro_max_card', true
FROM (VALUES
  ('discipline', 'ui_ux_pro_max_review',
   'UI/UX method: check an interface change against a prioritised quality list',
   $$Adapted from the UI UX Pro Max skill (nextlevelbuilder/ui-ux-pro-max-skill, MIT).
Use only when the job changes how something looks, reads, moves or is operated; skip it for backend, schema or infrastructure work.
Precedence: FOUNDATION.md and docs/canon, then docs/BOB_ENTERPRISE_SAAS_UX_TRAINING.md, then the existing tokens and components in apps/web/src and apps/mobile/src, then this list. Do not re-theme, add fonts or palettes, or borrow marketing styles; FCM is an operational product and every screen needs a schema-backed data path.
Check in priority order and stop at the first failure:
1. Accessibility: text contrast 4.5:1, visible focus, keyboard reach, labels on icon-only buttons, alt text.
2. Touch and interaction: targets at least 44x44 px with 8 px spacing, nothing hover-only, immediate pressed and loading feedback.
3. Performance: reserve space for async content (no layout shift), lazy-load heavy lists and images.
4. Consistency: reuse the shared component for the same job; SVG icons, never emoji as icons.
5. Layout: mobile first, no horizontal page scroll, wide tables become scroll regions or cards on small screens.
6. Type and colour: body 16 px, nothing under 12 px, semantic tokens rather than raw hex, never colour alone for meaning.
7. Motion: short, meaningful, respects prefers-reduced-motion.
8. Forms and feedback: visible labels (not placeholder-only), error next to the field, helper text, confirm before destructive actions, a success receipt afterwards.
9. Navigation: predictable back, deep links that restore the view and selection.
10. Charts and data: legends, readable tooltips, accessible palettes, empty and error states.
Before handing back, confirm loading, empty, error, success and permission states exist and that the human path works at desktop and mobile widths. In an editor checkout, detail is available with python .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux.$$,
   ARRAY['builder','vibe','ux','ui','frontend','design','accessibility','ui_ux_pro_max','discipline'])
) AS card(category, key, title, content, tags)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_knowledge_cards existing
  WHERE existing.organization_id IS NULL AND existing.key = card.key AND existing.is_active
);
